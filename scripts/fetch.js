import fetch from 'node-fetch';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';

const API_KEY = process.env.TWITTERAPI_KEY;
const BASE = 'https://api.twitterapi.io';

// June 1, 2025 00:00 UTC
const SINCE_TIME = 1748736000;
const UNTIL_TIME = Math.floor(Date.now() / 1000);
const QUERY = `(@tread_fi OR "$TREAD" OR "treadfi" OR "tread.fi") -is:retweet lang:en since_time:${SINCE_TIME} until_time:${UNTIL_TIME}`;

async function searchPage(cursor = '') {
  const params = new URLSearchParams({
    query: QUERY,
    queryType: 'Latest',
    ...(cursor ? { cursor } : {})
  });

  const r = await fetch(`${BASE}/twitter/tweet/advanced_search?${params}`, {
    headers: { 'X-API-Key': API_KEY }
  });

  if (!r.ok) throw new Error(`API error ${r.status}: ${await r.text()}`);
  return r.json();
}

async function main() {
  let existing = {};
  if (existsSync('data/leaderboard.json')) {
    try {
      const old = JSON.parse(readFileSync('data/leaderboard.json', 'utf8'));
      (old.users || []).forEach(u => { existing[u.handle.toLowerCase()] = u; });
      console.log(`Loaded ${Object.keys(existing).length} existing users`);
    } catch(e) { console.log('Starting fresh'); }
  }

  const fresh = {};
  let cursor = '';
  let page = 0;

  do {
    const data = await searchPage(cursor);
    const tweets = data.tweets || [];
    console.log(`Page ${page + 1}: ${tweets.length} tweets`);

    tweets.forEach(tweet => {
      // Пропускаем ретвиты
      if (tweet.text?.startsWith('RT @')) return;
      if (tweet.retweeted_tweet) return;

      // Пропускаем не-английские
      if (tweet.lang && tweet.lang !== 'en') return;

      // Дополнительная проверка релевантности
      const txt = (tweet.text || '').toLowerCase();
      const isRelevant = txt.includes('@tread_fi') ||
                         txt.includes('treadfi') ||
                         txt.includes('tread.fi');
      if (!isRelevant) return;

      // Пропускаем пустые реплаи
      if (tweet.isReply) {
        const textWithoutMentions = txt.replace(/@\w+/g, '').replace(/\s+/g, ' ').trim();
        if (textWithoutMentions.length < 5) return;
      }

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
          mentions: 0, keyword: 0, cashtag: 0, replies: 0,
          firstPost: tweet.createdAt,
          lastPost: tweet.createdAt,
          topPosts: []
        };
      }

      const u = fresh[key];
      u.views += tweet.viewCount || 0;
      u.likes += tweet.likeCount || 0;
      u.posts += 1;

      if (txt.includes('@tread_fi'))                        u.mentions++;
      if (txt.includes('treadfi') || txt.includes('tread.fi')) u.keyword++;
      if (txt.includes('$tread'))                           u.cashtag++;
      if (tweet.isReply)                                    u.replies++;

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

    cursor = data.next_cursor || '';
    page++;

    if (data.has_next_page) {
      await new Promise(r => setTimeout(r, 500));
    } else {
      break;
    }
  } while (true);

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
        name:      u.name,
        followers: u.followers,
        avatar:    u.avatar,
        views:    old.views    + u.views,
        likes:    old.likes    + u.likes,
        posts:    old.posts    + u.posts,
        mentions: old.mentions + u.mentions,
        keyword:  old.keyword  + u.keyword,
        cashtag:  old.cashtag  + u.cashtag,
        replies:  old.replies  + u.replies,
        firstPost: old.firstPost < u.firstPost ? old.firstPost : u.firstPost,
        lastPost:  old.lastPost  > u.lastPost  ? old.lastPost  : u.lastPost,
        topPosts:  [...old.topPosts, ...u.topPosts].sort((a,b) => b.views - a.views).slice(0, 3)
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
