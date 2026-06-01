import fetch from 'node-fetch';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';

const API_KEY = process.env.TWITTERAPI_KEY;
const BASE = 'https://api.twitterapi.io/twitter/tweet/advanced_search';

// June 1, 2025 00:00 UTC
const START_TS = 1748736000;
const END_TS   = Math.floor(Date.now() / 1000);

// Только точные совпадения — никакого голого tread
const QUERY_BASE = `(@tread_fi OR "$TREAD" OR "tread.fi" OR "treadfi") -filter:retweets -filter:replies lang:en`;

function parseTwitterTime(s) {
  return Math.floor(new Date(s).getTime() / 1000);
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

    // Сдвигаем окно до самого раннего твита
    const earliest = Math.min(...batch.map(t => parseTwitterTime(t.createdAt)));
    if (earliest < currentUntil) {
      currentUntil = earliest - 1;
    } else {
      break;
    }

    // Меньше 20 — окно исчерпано
    if (batch.length < 20) break;

    await new Promise(r => setTimeout(r, 300));
  }

  return tweets;
}

function isRelevant(tweet) {
  // Двойная проверка ретвитов (API флаг ненадёжен)
  if (tweet.isRetweet) return false;
  if (tweet.text?.startsWith('RT @')) return false;
  if (tweet.retweeted_tweet) return false;

  // Только английский
  if (tweet.lang && tweet.lang !== 'en') return false;

  // Твит ОБЯЗАН содержать одно из точных совпадений
  const txt = (tweet.text || '').toLowerCase();
  return (
    txt.includes('@tread_fi') ||
    txt.includes('$tread') ||
    txt.includes('tread.fi')
  );
}

async function main() {
  // Загружаем старые данные
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

  // Разбиваем на дневные окна
  const ONE_DAY = 86400;
  const days = [];
  for (let ts = START_TS; ts < END_TS; ts += ONE_DAY) {
    days.push({ since: ts, until: Math.min(ts + ONE_DAY, END_TS) });
  }

  console.log(`Processing ${days.length} day windows...`);

  const fresh = {};

  for (const { since, until } of days) {
    const date = new Date(since * 1000).toISOString().slice(0, 10);
    const tweets = await fetchWindow(since, until);
    const relevant = tweets.filter(isRelevant);

    console.log(`[${date}] ${tweets.length} raw → ${relevant.length} relevant`);

    relevant.forEach(tweet => {
      // Дедупликация
      if (seenIds.has(tweet.id)) return;
      seenIds.add(tweet.id);

      const author = tweet.author;
      if (!author) return;
      const key = author.userName.toLowerCase();

      if (!fresh[key]) {
        fresh[key] = {
          id: author.id,
          name: author.name,
          handle: author.userName,
          followers: author.followers || 0,
          avatar: author.profilePicture || '',
          views: 0, likes: 0, posts: 0,
          mentions: 0, cashtag: 0, keyword: 0, replies: 0,
          firstPost: tweet.createdAt,
          lastPost: tweet.createdAt,
          topPosts: []
        };
      }

      const u = fresh[key];
      const txt = (tweet.text || '').toLowerCase();

      u.views += tweet.viewCount  || 0;
      u.likes += tweet.likeCount  || 0;
      u.posts += 1;

      if (txt.includes('@tread_fi')) u.mentions++;
      if (txt.includes('$tread'))    u.cashtag++;
      if (txt.includes('tread.fi'))  u.keyword++;
      if (tweet.isReply)             u.replies++;

      if (tweet.createdAt < u.firstPost) u.firstPost = tweet.createdAt;
      if (tweet.createdAt > u.lastPost)  u.lastPost  = tweet.createdAt;

      u.topPosts.push({
        text:  tweet.text,
        id:    tweet.id,
        url:   tweet.url,
        views: tweet.viewCount || 0,
        likes: tweet.likeCount || 0
      });
    });

    // Пауза между днями
    await new Promise(r => setTimeout(r, 200));
  }

  // Топ-3 поста по просмотрам
  Object.values(fresh).forEach(u => {
    u.topPosts = u.topPosts.sort((a, b) => b.views - a.views).slice(0, 3);
  });

  // Merge
  const merged = { ...existing };
  Object.entries(fresh).forEach(([key, u]) => {
    if (merged[key]) {
      const old = merged[key];
      merged[key] = {
        ...old,
        name: u.name, followers: u.followers, avatar: u.avatar,
        views:    old.views    + u.views,
        likes:    old.likes    + u.likes,
        posts:    old.posts    + u.posts,
        mentions: old.mentions + u.mentions,
        cashtag:  old.cashtag  + u.cashtag,
        keyword:  old.keyword  + u.keyword,
        replies:  old.replies  + u.replies,
        firstPost: old.firstPost < u.firstPost ? old.firstPost : u.firstPost,
        lastPost:  old.lastPost  > u.lastPost  ? old.lastPost  : u.lastPost,
        topPosts: [...old.topPosts, ...u.topPosts]
          .sort((a,b) => b.views - a.views).slice(0, 3)
      };
    } else {
      merged[key] = u;
    }
  });

  const userList = Object.values(merged).sort((a,b) => b.views - a.views);
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
