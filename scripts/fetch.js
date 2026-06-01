import fetch from 'node-fetch';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';

const API_KEY = process.env.TWITTERAPI_KEY;
const BASE = 'https://api.twitterapi.io';

// Unix timestamp для Nov 18, 2025 00:00 UTC
const SINCE_TIME = 1747267200; // May 15, 2026 00:00 UTC
const UNTIL_TIME = 1748044800; // May 22, 2026 00:00 UTC
const QUERY = `(@nadoHQ OR "$NADO" OR "nado dex" OR "nado perps" OR "nado exchange" OR "nado trading" OR "trade on nado" OR "nado app") -is:retweet lang:en since_time:${SINCE_TIME} until_time:${UNTIL_TIME}`;
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
  // Загружаем старые данные
  let existing = {};
  if (existsSync('data/leaderboard.json')) {
    try {
      const old = JSON.parse(readFileSync('data/leaderboard.json', 'utf8'));
      (old.users || []).forEach(u => { existing[u.handle.toLowerCase()] = u; });
      console.log(`Loaded ${Object.keys(existing).length} existing users`);
    } catch(e) { console.log('Starting fresh'); }
  }

  // Собираем новые твиты
  const fresh = {};
  let cursor = '';
  let page = 0;
  const MAX_PAGES = 9999; // без лимита

  do {
    const data = await searchPage(cursor);
    const tweets = data.tweets || [];
    console.log(`Page ${page + 1}: ${tweets.length} tweets`);

    tweets.forEach(tweet => {
      // Пропускаем чистые ретвиты
      if (tweet.text?.startsWith('RT @')) return;
      if (tweet.retweeted_tweet) return;

      // Пропускаем не-английские твиты
if (tweet.lang && tweet.lang !== 'en') return;
      
      // Пропускаем пустые реплаи (только упоминание, никакого текста)
      if (tweet.isReply) {
        const textWithoutMentions = (tweet.text || '')
          .replace(/@\w+/g, '')
          .replace(/\s+/g, ' ')
          .trim();
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
      u.views  += tweet.viewCount  || 0;
      u.likes  += tweet.likeCount  || 0;
      u.posts  += 1;

      const txt = (tweet.text || '').toLowerCase();
      if (txt.includes('@nadohq'))                          u.mentions++;
      if (txt.includes('nado'))                             u.keyword++;
      if (txt.includes('$nado') || txt.includes('$ink'))   u.cashtag++;
      if (tweet.isReply)                                    u.replies++;

      // Обновляем даты
      if (tweet.createdAt < u.firstPost) u.firstPost = tweet.createdAt;
      if (tweet.createdAt > u.lastPost)  u.lastPost  = tweet.createdAt;

      // Топ посты по просмотрам
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

    if (data.has_next_page && page < MAX_PAGES) {
      await new Promise(r => setTimeout(r, 500));
    } else {
      break;
    }
  } while (true);

  // Оставляем топ-3 поста по просмотрам для каждого юзера
  Object.values(fresh).forEach(u => {
    u.topPosts = u.topPosts
      .sort((a, b) => b.views - a.views)
      .slice(0, 3);
  });

  // Merge старых и новых данных
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
