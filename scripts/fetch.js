import fetch from 'node-fetch';
import { writeFileSync, mkdirSync } from 'fs';

const BEARER = process.env.BEARER_TOKEN;
const START_DATE = '2025-11-18T00:00:00Z';
const QUERY = '(@nadoHQ OR nado OR $NADO OR $INK) lang:en -is:retweet';
const MAX_PAGES = 10;

const headers = { Authorization: `Bearer ${BEARER}` };

async function searchTweets(nextToken) {
  const params = new URLSearchParams({
    query: QUERY,
    start_time: START_DATE,
    'tweet.fields': 'public_metrics,author_id,created_at,referenced_tweets,text',
    expansions: 'author_id',
    'user.fields': 'name,username,public_metrics,profile_image_url',
    max_results: '100',
    ...(nextToken ? { next_token: nextToken } : {})
  });
  const r = await fetch(
    `https://api.twitter.com/2/tweets/search/recent?${params}`,
    { headers }
  );
  if (!r.ok) throw new Error(`API error ${r.status}: ${await r.text()}`);
  return r.json();
}

async function main() {
  const users = {};
  let nextToken;
  let page = 0;

  do {
    const data = await searchTweets(nextToken);
    const usersMap = {};
    (data.includes?.users || []).forEach(u => usersMap[u.id] = u);

    (data.data || []).forEach(tweet => {
      const user = usersMap[tweet.author_id];
      if (!user) return;
      const uid = user.id;

      if (!users[uid]) {
        users[uid] = {
          id: uid,
          name: user.name,
          handle: user.username,
          followers: user.public_metrics?.followers_count || 0,
          avatar: user.profile_image_url || '',
          views: 0, likes: 0, posts: 0,
          mentions: 0, keyword: 0, cashtag: 0, replies: 0,
          firstPost: tweet.created_at,
          lastPost: tweet.created_at,
          topPosts: []
        };
      }

      const u = users[uid];
      const m = tweet.public_metrics || {};
      u.views += m.impression_count || 0;
      u.likes  += m.like_count || 0;
      u.posts  += 1;

      const txt = (tweet.text || '').toLowerCase();
      if (txt.includes('@nadohq'))               u.mentions++;
      if (txt.includes('nado'))                  u.keyword++;
      if (txt.includes('$nado') || txt.includes('$ink')) u.cashtag++;
      if (tweet.referenced_tweets?.some(r => r.type === 'replied_to')) u.replies++;

      if (tweet.created_at < u.firstPost) u.firstPost = tweet.created_at;
      if (tweet.created_at > u.lastPost)  u.lastPost  = tweet.created_at;

      if (u.topPosts.length < 3) {
        u.topPosts.push({
          text:  tweet.text,
          id:    tweet.id,
          views: m.impression_count || 0,
          likes: m.like_count || 0
        });
      }
    });

    nextToken = data.meta?.next_token;
    page++;

    if (page < MAX_PAGES && nextToken) {
      await new Promise(r => setTimeout(r, 1000));
    }
  } while (nextToken && page < MAX_PAGES);

  const userList = Object.values(users).sort((a, b) => b.views - a.views);

  const totals = userList.reduce(
    (t, u) => ({
      views: t.views + u.views,
      likes: t.likes + u.likes,
      posts: t.posts + u.posts
    }),
    { views: 0, likes: 0, posts: 0 }
  );

  mkdirSync('data', { recursive: true });
  writeFileSync(
    'data/leaderboard.json',
    JSON.stringify({
      updatedAt: new Date().toISOString(),
      totals: { ...totals, users: userList.length },
      users: userList
    }, null, 2)
  );

  console.log(`✓ Done: ${userList.length} users, ${totals.posts} posts, ${totals.views} views`);
}

main().catch(e => { console.error(e); process.exit(1); });
