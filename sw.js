// Service Worker for p-book — full offline support
// Pre-caches the entire book (~1.3 MB) on first visit
const CACHE_NAME = 'pbook-v2';

const PRECACHE = [
  '/',
  '/index.html',
  '/favicon.svg',
  // JS
  '/js/app.js',
  '/js/config.js',
  '/js/recombee.js',
  '/js/markdown.js',
  '/js/diagrams.js',
  '/js/tutor.js',
  // CSS
  '/css/style.css',
  // Book index
  '/content/book.json',
  // Games
  '/games/ab-test.json',
  '/games/bubble-pop.json',
  '/games/cold-start.json',
  '/games/method-match.json',
  '/games/pipeline-order.json',
  '/games/privacy-spotter.json',
  '/games/signal-sort.json',
  '/games/taste-match.json',
  // Images
  '/images/hero-recsys.svg',
  '/images/og-cover.svg',
  '/images/comic-bandits.svg',
  '/images/comic-cf.svg',
  '/images/comic-mf.svg',
  '/images/diagram-algorithm-taxonomy.svg',
  '/images/diagram-ann-search.svg',
  '/images/diagram-attention.svg',
  '/images/diagram-bandit-exploration.svg',
  '/images/diagram-cf-matrix.svg',
  '/images/diagram-data-sources.svg',
  '/images/diagram-embedding-space.svg',
  '/images/diagram-eval-stack.svg',
  '/images/diagram-mf-decomposition.svg',
  '/images/diagram-objectives.svg',
  '/images/diagram-pipeline.svg',
  '/images/diagram-stakeholders.svg',
  '/images/diagram-two-tower.svg',
  '/images/kids-ab-test.svg',
  '/images/kids-cold-start.svg',
  '/images/kids-collaborative-filtering.svg',
  '/images/kids-content-based.svg',
  '/images/kids-digital-footprints.svg',
  '/images/kids-filter-bubble.svg',
  '/images/kids-pattern-detective.svg',
  '/images/kids-pipeline.svg',
  '/images/kids-recommendations-everywhere.svg',
  '/images/kids-three-jobs.svg',
  // All content markdown files
  '/content/ch1-what-are-recommendations/01-spine-have-you-noticed.md',
  '/content/ch1-what-are-recommendations/02-spine-recommendations-everywhere.md',
  '/content/ch1-what-are-recommendations/03-spine-not-magic.md',
  '/content/ch1-what-are-recommendations/03a-sidebar-wrong-recs.md',
  '/content/ch1-what-are-recommendations/03b-depth-thinker-patterns.md',
  '/content/ch1-what-are-recommendations/04-spine-three-jobs.md',
  '/content/ch1-what-are-recommendations/04b-sidebar-would-you-rather.md',
  '/content/ch1-what-are-recommendations/05-question-what-type.md',
  '/content/ch1-what-are-recommendations/06-spine-worksheet-match-apps.md',
  '/content/ch2-how-they-learn/01-spine-digital-footprints.md',
  '/content/ch2-how-they-learn/01a-depth-explorer-what-they-track.md',
  '/content/ch2-how-they-learn/01b-sidebar-guess-the-signal.md',
  '/content/ch2-how-they-learn/01c-game-signal-sort.md',
  '/content/ch2-how-they-learn/02-spine-three-types-of-clues.md',
  '/content/ch2-how-they-learn/02a-sidebar-incognito.md',
  '/content/ch2-how-they-learn/02b-sidebar-myth-buster.md',
  '/content/ch2-how-they-learn/02c-game-cold-start.md',
  '/content/ch2-how-they-learn/03-spine-your-data-your-choice.md',
  '/content/ch2-how-they-learn/03b-depth-creator-experiment.md',
  '/content/ch2-how-they-learn/04-spine-worksheet-data-detective.md',
  '/content/ch3-different-ways-to-recommend/01-spine-ask-your-friends.md',
  '/content/ch3-different-ways-to-recommend/01a-depth-explorer-cf-demo.md',
  '/content/ch3-different-ways-to-recommend/01b-depth-creator-build-cf.md',
  '/content/ch3-different-ways-to-recommend/01c-sidebar-netflix-story.md',
  '/content/ch3-different-ways-to-recommend/01e-game-taste-match.md',
  '/content/ch3-different-ways-to-recommend/02-spine-look-at-the-thing.md',
  '/content/ch3-different-ways-to-recommend/02a-depth-thinker-compare.md',
  '/content/ch3-different-ways-to-recommend/02b-sidebar-spot-the-method.md',
  '/content/ch3-different-ways-to-recommend/02c-game-method-match.md',
  '/content/ch3-different-ways-to-recommend/02d-spine-bandits.md',
  '/content/ch3-different-ways-to-recommend/02e-spine-deep-similarity.md',
  '/content/ch3-different-ways-to-recommend/03-spine-whats-popular.md',
  '/content/ch3-different-ways-to-recommend/03a-sidebar-popularity-trap.md',
  '/content/ch3-different-ways-to-recommend/04-spine-the-pipeline.md',
  '/content/ch3-different-ways-to-recommend/04a-depth-explorer-pipeline-visual.md',
  '/content/ch3-different-ways-to-recommend/04b-sidebar-speed-challenge.md',
  '/content/ch3-different-ways-to-recommend/04c-game-pipeline.md',
  '/content/ch3-different-ways-to-recommend/04d-spine-search-and-recs.md',
  '/content/ch3-different-ways-to-recommend/05-question-method.md',
  '/content/ch4-making-them-better/01-spine-filter-bubbles.md',
  '/content/ch4-making-them-better/01a-depth-thinker-echo-chamber.md',
  '/content/ch4-making-them-better/01c-sidebar-experiment-idea.md',
  '/content/ch4-making-them-better/01d-game-bubble-pop.md',
  '/content/ch4-making-them-better/02-spine-fairness.md',
  '/content/ch4-making-them-better/02a-sidebar-youtube-algorithm.md',
  '/content/ch4-making-them-better/02b-sidebar-unfair-game.md',
  '/content/ch4-making-them-better/02c-spine-objectives.md',
  '/content/ch4-making-them-better/02d-spine-explainability.md',
  '/content/ch4-making-them-better/03-spine-testing.md',
  '/content/ch4-making-them-better/03a-depth-explorer-ab-test.md',
  '/content/ch4-making-them-better/03b-game-ab-test.md',
  '/content/ch4-making-them-better/04-question-ethics.md',
  '/content/ch5-build-your-own/01-spine-you-can-do-it.md',
  '/content/ch5-build-your-own/02-spine-step1-collect.md',
  '/content/ch5-build-your-own/02a-depth-creator-spreadsheet.md',
  '/content/ch5-build-your-own/03-spine-step2-find-similar.md',
  '/content/ch5-build-your-own/03a-depth-thinker-math.md',
  '/content/ch5-build-your-own/03b-sidebar-real-numbers.md',
  '/content/ch5-build-your-own/04-spine-step3-recommend.md',
  '/content/ch5-build-your-own/04a-depth-creator-code.md',
  '/content/ch5-build-your-own/04b-sidebar-debug-challenge.md',
  '/content/ch5-build-your-own/05-spine-step4-improve.md',
  '/content/ch5-build-your-own/05a-sidebar-career.md',
  '/content/ch5-build-your-own/05b-spine-get-recommended.md',
  '/content/ch5-build-your-own/05c-spine-seo-for-algorithms.md',
  '/content/ch5-build-your-own/06-question-next.md',
  '/content/ch6-ethics-and-you/01-spine-who-decides.md',
  '/content/ch6-ethics-and-you/01b-sidebar-rabbit-hole.md',
  '/content/ch6-ethics-and-you/02-spine-addictive-design.md',
  '/content/ch6-ethics-and-you/02a-depth-creator-take-control.md',
  '/content/ch6-ethics-and-you/02b-sidebar-dopamine.md',
  '/content/ch6-ethics-and-you/02c-spine-adtech-vs-recs.md',
  '/content/ch6-ethics-and-you/03-spine-privacy-for-real.md',
  '/content/ch6-ethics-and-you/03a-depth-explorer-check-your-data.md',
  '/content/ch6-ethics-and-you/03b-sidebar-age-guessing.md',
  '/content/ch6-ethics-and-you/03d-game-privacy-spotter.md',
  '/content/ch6-ethics-and-you/04-spine-ai-and-you.md',
  '/content/ch6-ethics-and-you/04a-depth-thinker-hard-questions.md',
  '/content/ch6-ethics-and-you/04b-sidebar-eu-law.md',
  '/content/ch6-ethics-and-you/04c-spine-conversational-recs.md',
  '/content/ch6-ethics-and-you/05-question-ethics.md',
];

// Install: pre-cache everything (~1.3 MB total)
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(PRECACHE))
  );
  self.skipWaiting();
});

// Activate: clean old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
    ))
  );
  self.clients.claim();
});

// Fetch strategy:
// - API calls → network only (offline queue handles retries)
// - Everything else → cache first, update in background
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // API calls — network only
  if (url.pathname.startsWith('/.netlify/') || url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(event.request).catch(() => new Response('{"error":"offline"}', {
        status: 503, headers: { 'Content-Type': 'application/json' }
      }))
    );
    return;
  }

  // Everything else — cache first, update in background
  event.respondWith(
    caches.match(event.request).then(cached => {
      const fetchPromise = fetch(event.request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => cached);

      return cached || fetchPromise;
    })
  );
});
