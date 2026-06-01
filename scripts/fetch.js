import fetch from 'node-fetch';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';

const API_KEY = process.env.TWITTERAPI_KEY;
const BASE = 'https://api.twitterapi.io/twitter/tweet/advanced_search';

// Only yesterday
const now = new Date();
const todayMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
const yesterdayMidnight = new Date(todayMidnight.getTime() - 86400000);
const START_TS = Math.floor(yesterdayMidnight.getTime() / 1000);
const END_TS   = Math.floor(todayMidnight.getTime() / 1000);

const QUERY_BASE = `@tread_fi -filter:replies`;

function parseTwitterTime(s) {
  return Math.floor(new Date(s).getTime() / 1000);
}

function isRelevant(tweet) {
  if (tweet.isRetweet) return false;
  if (tweet.text?.startsWith('RT @')) return false;
  if (tweet.retweeted_tweet) return false;
  if (tweet.isReply) return false;

  const txt = (tweet.text || '').toLowerCase();

  const hasMention = txt.includes('@tread_fi');
  const hasCashtag = /\$tread\b/.test(txt);
  const hasUrl     = txt.includes('tread.fi') || txt.includes('app.tread.fi');
  const hasTreadfi = /\btreadfi\b/.test(txt);

  return hasMention || hasCashtag || hasUrl || hasTreadfi;
}

async function fetchWindow(sinceTs, untilTs) {
  const tweets = [];
  let currentUntil = untilTs;
  let calls = 0;
  const MAX_CALLS = 200;

  while (currentUntil > sinceTs && calls < MAX_CALLS) {
    const query = `${QUERY_BASE} since_time:${sinceTs} until_time:${currentUntil}`;
    const params = new URLSearchParams({ query, queryType: 'Latest' });

    const r = await fetch(`${BASE}?${params}`, {
      headers: { 'X-API-Key': API_KEY }
    });

    if (!r.ok) {
      console.error(`API error ${r.status}: ${await r.text()}`);
      break;
    }

    const data = await r.json();
    const batch = data.tweets || [];
    calls++;

    if (!batch.length) break;

    tweets.push(...batch);

    const earliest = Math.min(...batch.map(t => parseTwitterTime(t.createdAt)));
    if (earliest < currentUntil) {
      currentUntil = earliest - 1;
    } else {
      break;
    }

    if (batch.length < 20) break;

    await new Promise(r => setTimeout(r, 300));
  }

  return tweets;
}

async function main() {
  let existing = {};
  const seenIds = new Set();

  if (existsSync('data/leaderboard.json')) {
    try {
      const old = JSON.parse(readFileSync('data/leaderboard.json', 'utf8'));
      (old.users || []).forEach(u => {
        existing[u.handle.toLowerCase()] = u;
        (u.topPosts || []).forEach(p => p.id && seenIds.add(p.id));
      });
      console.log(`Loaded ${Object.keys(existing).length} existing users`);
    } catch(e) { console.log('Starting fresh'); }
  }

  const date = yesterdayMidnight.toISOString().slice(0, 10);
  console.log(`Fetching ${date}...`);

  const tweets = await fetchWindow(START_TS, END_TS);
  const relevant = tweets.filter(isRelevant);

  console.log(`${tweets.length} raw → ${relevant.length} relevant`);

  const fresh = {};

  relevant.forEach(tweet => {
    if (seenIds.has(tweet.id)) return;
    seenIds.add(tweet.id);

    const author = tweet.author;
    if (!author) return;
    const key = author.userName.toLowerCase();

    if (!fresh[key]) {
      fresh[key] = {
        id:        author.id,
        name:      author.name,
        handle:    author.userName,
        followers: author.followers || 0,
        avatar:    author.profilePicture || '',
        views: 0, likes: 0, posts: 0,
        mentions: 0, cashtag: 0, keyword: 0,
        firstPost: tweet.createdAt,
        lastPost:  tweet.createdAt,
        topPosts:  []
      };
    }

    const u = fresh[key];
    const txt = (tweet.text || '').toLowerCase();

    u.views += tweet.viewCount || 0;
    u.likes += tweet.likeCount || 0;
    u.posts += 1;

    if (txt.includes('@tread_fi'))                            u.mentions++;
    if (/\$tread\b/.test(txt))                                u.cashtag++;
    if (txt.includes('tread.fi') || /\btreadfi\b/.test(txt)) u.keyword++;

    if (parseTwitterTime(tweet.createdAt) < parseTwitterTime(u.firstPost)) u.firstPost = tweet.createdAt;
    if (parseTwitterTime(tweet.createdAt) > parseTwitterTime(u.lastPost))  u.lastPost  = tweet.createdAt;

    u.topPosts.push({
      text:  tweet.text,
      id:    tweet.id,
      url:   tweet.url,
      views: tweet.viewCount || 0,
      likes: tweet.likeCount || 0
    });
  });

  Object.values(fresh).forEach(u => {
    u.topPosts = u.topPosts.sort((a, b) => b.views - a.views).slice(0, 3);
  });

  const merged = { ...existing };

  Object.entries(fresh).forEach(([key, u]) => {
    if (merged[key]) {
      const old = merged[key];
      merged[key] = {
        ...old,
        name:      u.name,
        followers: u.followers,
        avatar:    u.avatar,
        views:    old.views    + u.views,
        likes:    old.likes    + u.likes,
        posts:    old.posts    + u.posts,
        mentions: old.mentions + u.mentions,
        cashtag:  old.cashtag  + u.cashtag,
        keyword:  old.keyword  + u.keyword,
        firstPost: parseTwitterTime(old.firstPost) < parseTwitterTime(u.firstPost) ? old.firstPost : u.firstPost,
        lastPost:  parseTwitterTime(old.lastPost)  > parseTwitterTime(u.lastPost)  ? old.lastPost  : u.lastPost,
        topPosts:  [...old.topPosts, ...u.topPosts]
          .sort((a, b) => b.views - a.views)
          .slice(0, 3)
      };
    } else {
      merged[key] = u;
    }
  });

  const userList = Object.values(merged).sort((a, b) => b.views - a.views);
  const totals = userList.reduce(
    (t, u) => ({ views: t.views+u.views, likes: t.likes+u.likes, posts: t.posts+u.posts }),
    { views: 0, likes: 0, posts: 0 }
  );

  mkdirSync('data', { recursive: true });
  writeFileSync('data/leaderboard.json', JSON.stringify({
    updatedAt: new Date().toISOString(),
    totals: { ...totals, users: userList.length },
    users: userList
  }, null, 2));

  console.log(`✓ Done: ${userList.length} users, ${totals.posts} posts, ${totals.views} views`);
}

main().catch(e => { console.error(e); process.exit(1); });
