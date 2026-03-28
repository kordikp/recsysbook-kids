// p-book v3: Adaptive UX with Netflix home, map, search, feedback, Recombee-powered

import { CONFIG } from './config.js';
import { renderMarkdown, parseFrontmatter } from './markdown.js';
import { RecombeeClient, UserModel } from './recombee.js?v=6';
import { getDiagram } from './diagrams.js';
import { MockTutorEngine, ConversationManager } from './tutor.js';

class PBook {
  constructor() {
    this.book = null;
    this.chapters = {};
    this.allBlocks = [];
    this.rc = new RecombeeClient();
    this.user = new UserModel();
    this.currentView = 'home';
    this.feedbackTimeout = null;
    this.topicIndex = {};  // topic → [blockIds]
    this.blockTopics = {}; // blockId → [topics]
    this.tutor = new MockTutorEngine();
    this.convManager = new ConversationManager();
    this._activeConvId = null;
  }

  // Feature toggle helper
  _f(name) { return CONFIG.features[name] !== false;
  }

  // ===== INIT =====
  async init() {
    try {
      this.book = await (await fetch(CONFIG.book.bookIndex)).json();
    } catch (e) {
      document.body.innerHTML = '<div style="padding:3em;text-align:center;font-family:sans-serif;color:#888">Could not load book. Run <code>./serve.sh</code> first.</div>';
      return;
    }
    // Preload all content for search and map
    await this.loadAllContent();
    this.autoTagBlocks();
    this.rc.setAllBlocks(this.allBlocks);
    this.rc._loadInteractions(); // Restore persisted interactions

    // Load feature toggles
    this._loadFeatureToggles();

    // Sync user profile to Recombee
    if (this.rc.enabled) {
      const prog = this.user.getProgress(this.allBlocks);
      const coreBlocks = this.allBlocks.filter(b => b.meta.core);
      const coreRead = coreBlocks.filter(b => this.user.readBlocks.has(b.meta.id)).length;
      this.rc.setUserProperties({
        voice: this.user.preferredVoice || 'universal',
        level: this.user.level,
        xp: this.user.xp,
        readCount: prog.read,
        readPct: prog.pct,
        coreRead,
        coreTotal: coreBlocks.length,
        sessions: this.user.sessionCount,
        completedMissions: (this.user.completedMissions || []).length,
        activePath: this.user.activePath || '',
      });
    }

    // Detect stale data: if readBlocks has IDs that don't exist in allBlocks, reset
    if (this.user.readBlocks.size > 0) {
      const validIds = new Set(this.allBlocks.map(b => b.meta.id));
      const stale = [...this.user.readBlocks].filter(id => !validIds.has(id));
      if (stale.length > this.user.readBlocks.size * 0.3) {
        // More than 30% of read IDs are invalid — data is from old version
        this.user.reset();
      }
    }

    // Check for deep link: #blockId or #mission-missionId
    const hash = window.location.hash?.substring(1);
    if (hash) {
      if (hash.startsWith('mission-')) {
        // Mission deep link
        const missionId = hash.replace('mission-', '');
        document.getElementById('onboarding').classList.add('hidden');
        this.updateXPBadge();
        this.switchView('glossary');
        this.showMission(missionId);
      } else if (hash === 'quiz') {
        document.getElementById('onboarding').classList.add('hidden');
        this.updateXPBadge();
        this.switchView('quiz');
      } else if (hash.startsWith('quiz-')) {
        // Single quiz card deep link — show in quiz view
        const blockId = hash.replace('quiz-', '');
        document.getElementById('onboarding').classList.add('hidden');
        this.updateXPBadge();
        this._sharedQuizBlock = blockId;
        this.switchView('quiz');
      } else if (this.findBlock(hash)) {
        // Block deep link
        document.getElementById('onboarding').classList.add('hidden');
        this.updateXPBadge();
        this.openBlock(hash, 'share');
        this._sharedBlockId = hash;
      }
    }

    this.applyTheme();

    // Auto-restore session: fill displayName from cert-name if missing, sync Recombee identity
    const authRestore = this._getAuth();
    if (authRestore) {
      if (!authRestore.displayName) {
        const certName = localStorage.getItem('pbook-cert-name');
        if (certName) { authRestore.displayName = certName; this._setAuth(authRestore); }
      }
      // Ensure Recombee identity matches account
      const accountUid = 'acct-' + authRestore.email.toLowerCase().trim().replace(/[^a-z0-9]/g, '-');
      if (this.rc.userId !== accountUid) {
        this.rc.userId = accountUid;
        localStorage.setItem('pbook-uid', accountUid);
      }
    }

    // Customize welcome screen for returning users
    this._customizeWelcome();

    // Auto-sync for logged-in users: save every 2 minutes
    setInterval(() => {
      if (this._getAuth()) this.syncProfile().catch(() => {});
    }, 120000);
    // Also sync on page unload
    window.addEventListener('beforeunload', () => {
      const auth = this._getAuth();
      if (auth) {
        const blob = new Blob([JSON.stringify({
          action: 'save', email: auth.email, token: auth.token,
          profileData: this._collectProfileData(),
        })], { type: 'application/json' });
        navigator.sendBeacon?.(this._authEndpoint(), blob);
      }
    });
  }

  async loadAllContent() {
    for (let i = 0; i < this.book.chapters.length; i++) {
      const ch = this.book.chapters[i];
      const dir = `${CONFIG.book.contentDir}/${ch.directory}`;
      const blocks = await Promise.all(ch.files.map(async f => {
        try {
          const text = await (await fetch(`${dir}/${f}`)).text();
          const { meta, body } = parseFrontmatter(text);
          const seq = f.match(/^(\d+)([a-z]?)/);
          const sequence = seq ? parseInt(seq[1]) * 10 + (seq[2] ? seq[2].charCodeAt(0) - 96 : 0) : 999;
          return { ...meta, body, sequence, _chapter: ch.id, _chapterNum: ch.number, _chapterTitle: ch.title, meta: { ...meta, chapter: ch.id } };
        } catch (e) { return null; }
      }));
      const isAdmin = localStorage.getItem('pbook-admin') === '1';
      const valid = blocks.filter(b => b && (!b.status || b.status === 'accepted' || isAdmin)).sort((a, b) => a.sequence - b.sequence);
      this.chapters[i] = { ...ch, blocks: valid };
      valid.forEach(b => { b._chapterIdx = i; this.allBlocks.push({ meta: b, body: b.body, _chapter: ch.id }); });
    }
  }

  autoTagBlocks() {
    const TOPICS = {
      'Collaborative Filtering': ['collaborative filter', 'user-based cf', 'item-based cf'],
      'Matrix Factorization': ['matrix factor', 'svd', 'als ', 'latent factor', 'bpr'],
      'Deep Learning': ['deep learn', 'neural', 'transformer', 'attention mechanism', 'gru4rec', 'sasrec'],
      'Cold Start': ['cold start', 'cold-start', 'new user', 'new item', 'onboarding'],
      'Conversion & Revenue': ['conversion', 'revenue', 'roi ', 'monetiz', 'purchase', 'business impact'],
      'Engagement & Retention': ['engagement', 'ctr', 'click-through', 'session length', 'retention', 'churn'],
      'Diversity & Fairness': ['diversity', 'fairness', 'coverage', 'filter bubble', 'echo chamber', 'long tail'],
      'Search & Retrieval': ['search', 'query', 'retrieval', 'ann search', 'faiss', 'nearest neighbor'],
      'A/B Testing & Evaluation': ['a/b test', 'experiment', 'ndcg', 'evaluation', 'metric'],
      'Content-Based Filtering': ['content-based', 'text embed', 'image embed', 'beeformer'],
      'Bandits & Exploration': ['bandit', 'exploration', 'exploit', 'thompson sampling', 'ucb'],
      'Recombee Platform': ['recombee', 'reql', 'beeformer', 'scenario config', 'recombee:personal'],
      'Objectives & Strategy': ['objective', 'stakeholder', 'north star', 'multi-objective', 'alignment'],
      'Data & Signals': ['interaction data', 'item catalog', 'user catalog', 'feedback loop', 'implicit'],
      'Privacy & Ethics': ['privacy', 'gdpr', 'ethical', 'transparency', 'consent'],
    };
    this.allBlocks.forEach(b => {
      const text = ((b.meta.title || '') + ' ' + (b.body || '')).toLowerCase();
      const tags = [];
      for (const [topic, keywords] of Object.entries(TOPICS)) {
        if (keywords.some(kw => text.includes(kw))) tags.push(topic);
      }
      this.blockTopics[b.meta.id] = tags;
      tags.forEach(t => {
        if (!this.topicIndex[t]) this.topicIndex[t] = [];
        this.topicIndex[t].push(b.meta.id);
      });
    });
  }

  // ===== ONBOARDING =====
  showStep(n) {
    document.querySelectorAll('.step').forEach(s => s.classList.remove('active'));
    document.querySelector(`.step[data-step="${n}"]`).classList.add('active');
  }


  _saveFeatureToggles() {
    const get = id => document.getElementById(id)?.checked !== false;
    const features = {
      gamification: get('optGamification'),
      personalization: get('optPersonalization'),
      spaceRepetition: get('optRecall'),
      missions: get('optMissions'),
      games: get('optGames'),
      highlights: get('optHighlights'),
    };
    localStorage.setItem('pbook-features', JSON.stringify(features));
    Object.assign(CONFIG.features, features);
    if (!features.personalization) this.rc.enabled = false;
  }

  _loadFeatureToggles() {
    try {
      const saved = JSON.parse(localStorage.getItem('pbook-features') || '{}');
      if (Object.keys(saved).length) Object.assign(CONFIG.features, saved);
      if (!CONFIG.features.personalization) this.rc.enabled = false;
    } catch (e) {}
  }

  startAndGo(view) {
    this._saveFeatureToggles();
    document.getElementById('onboarding').classList.add('hidden');
    this.updateVoiceBadge();
    this.updateXPBadge();
    if (!this._f('missions')) document.querySelector('[data-view="glossary"]')?.style.setProperty('display', 'none');
    this.switchView(view || 'home');
    // First-time tour
    if (!localStorage.getItem('pbook-tour-done')) {
      setTimeout(() => this.startTour(), 1000);
    }
  }

  startWithVoiceAndGo(view) {
    // Pick voice from inline selector on welcome screen
    const sel = document.querySelector('.intro-voice.selected');
    if (sel) this.user.setVoice(sel.dataset.voice);
    this.startAndGo(view);
  }

  startRandom() {
    // Random reading mode for A/B testing
    const modes = ['glossary', 'home', 'read', 'map'];
    const mode = modes[Math.floor(Math.random() * modes.length)];
    this.rc.logEvent('random_start', { mode });
    this.startWithVoiceAndGo(mode);
  }

  showWelcome() {
    const overlay = document.getElementById('onboarding');
    overlay.classList.remove('hidden');
    this.showStep(0);
    this._customizeWelcome();
  }

  _customizeWelcome() {
    const u = this.user;
    const prog = u.getProgress(this.allBlocks);
    const isReturning = prog.read > 0;
    const auth = this._getAuth();
    const dueRecalls = this._f('spaceRepetition') ? u.getDueRecalls() : [];

    // Find the main CTA button
    const ctaBtn = document.querySelector('.step[data-step="0"] .btn-primary.btn-large');
    if (!ctaBtn) return;

    if (!isReturning) return; // cold start — keep default "Start reading"

    // Returning user — change CTA
    const continueBlock = this.getContinueBlock();
    ctaBtn.textContent = 'Continue reading \u{1F4D6}';
    ctaBtn.onclick = () => this.startWithVoiceAndGo('home');

    // Add extra buttons below CTA
    let extras = document.getElementById('welcomeExtras');
    if (!extras) {
      extras = document.createElement('div');
      extras.id = 'welcomeExtras';
      extras.style.cssText = 'display:flex;flex-wrap:wrap;gap:.4em;justify-content:center;margin-top:.6em';
      ctaBtn.after(extras);
    }

    let html = '';

    // Memory cards button
    if (dueRecalls.length > 0) {
      html += `<button class="btn-secondary" style="font-size:.78rem;padding:.4em .8em;border-radius:8px;border:1.5px solid var(--warn);color:var(--warn);background:var(--warn-bg)" onclick="app.startAndGo('quiz');setTimeout(()=>app.startPractice(true),300)">\u{1F9E0} ${dueRecalls.length} cards due</button>`;
    } else if (Object.keys(u.recall).length > 0) {
      html += `<button class="btn-secondary" style="font-size:.78rem;padding:.4em .8em;border-radius:8px;border:1.5px solid var(--accent);color:var(--accent)" onclick="app.startAndGo('quiz')">\u{1F9E0} Test knowledge</button>`;
    }

    // Profile link
    if (auth) {
      html += `<button class="btn-secondary" style="font-size:.78rem;padding:.4em .8em;border-radius:8px;border:1.5px solid var(--border);color:var(--text-2)" onclick="app.startAndGo('profile')">${this.getLevelIcon()} ${this.escHtml(auth.displayName || 'Profile')}</button>`;
    } else {
      html += `<button class="btn-secondary" style="font-size:.78rem;padding:.4em .8em;border-radius:8px;border:1.5px solid var(--border);color:var(--text-2)" onclick="app.startAndGo('profile')">Your profile (${prog.pct}%)</button>`;
    }

    // Progress summary
    html += `<div style="width:100%;font-size:.7rem;color:var(--text-3);text-align:center;margin-top:.2em">${prog.read}/${prog.total} sections &middot; ${u.xp} XP &middot; Lv.${u.level}</div>`;

    extras.innerHTML = html;
  }

  startApp() {
    document.getElementById('onboarding').classList.add('hidden');
    this.updateVoiceBadge();
    this.updateXPBadge();
    if (!this._f('missions')) document.querySelector('[data-view="glossary"]')?.style.setProperty('display', 'none');
    this.switchView('home');
    // First-time tour
    if (!localStorage.getItem('pbook-tour-done')) {
      setTimeout(() => this.startTour(), 1500);
    }
  }

  // ===== ONBOARDING TOUR =====
  startTour() {
    this._tourSteps = [
      { target: '.tab[data-view="home"]', text: "\u{1F3E0} This is your Home! It's like Netflix but for learning. Scroll through and pick whatever looks cool.", pos: 'top' },
      { target: '.tab[data-view="read"]', text: "\u{1F4F1} The Feed! Just keep scrolling — the app figures out what to show you next. Like TikTok, but you actually learn stuff.", pos: 'top' },
      { target: '.tab[data-view="glossary"]', text: "\u{1F3AF} Missions! Each one is a quest with a story and a final boss quiz at the end. Beat the boss = earn a title!", pos: 'top' },
      { target: '.tab[data-view="map"]', text: "\u{1F5FA} The Map! See everything in the book, plus your saved stuff and notes. Tap any chapter to jump there.", pos: 'top' },
      { target: '.tab[data-view="chat"]', text: "\u{1F916} The Tutor! Got a question? Ask it here — it knows the whole book. It's like having a super-smart friend.", pos: 'top' },
      { target: '#xpBadge', text: "\u{1F31F} This is your level! You get XP for reading, playing mini-games, and finishing missions. Level up to unlock cool themes!", pos: 'bottom' },
      { target: null, text: "You're all set! Just tap anything that looks interesting. There's no wrong way to read this book. If you ever get lost, tap \"p-book\" up top to come back here. GO! \u{1F680}", pos: 'center' },
    ];
    this._tourIdx = 0;
    this._showTourStep();
  }

  _showTourStep() {
    // Remove previous
    document.getElementById('tourOverlay')?.remove();

    if (this._tourIdx >= this._tourSteps.length) {
      localStorage.setItem('pbook-tour-done', '1');
      return;
    }

    const step = this._tourSteps[this._tourIdx];
    const total = this._tourSteps.length;
    const isLast = this._tourIdx === total - 1;

    const overlay = document.createElement('div');
    overlay.id = 'tourOverlay';
    overlay.className = 'tour-overlay';

    if (step.target) {
      const el = document.querySelector(step.target);
      if (el) {
        const rect = el.getBoundingClientRect();
        // Highlight circle
        overlay.innerHTML = `<div class="tour-highlight" style="top:${rect.top - 4}px;left:${rect.left - 4}px;width:${rect.width + 8}px;height:${rect.height + 8}px"></div>`;
        // Tooltip
        const tipTop = step.pos === 'top' ? rect.top - 80 : rect.bottom + 12;
        const tipLeft = Math.max(10, Math.min(rect.left, window.innerWidth - 260));
        overlay.innerHTML += `<div class="tour-tip" style="top:${tipTop}px;left:${tipLeft}px">
          <div class="tour-text">${step.text}</div>
          <div class="tour-nav">
            <span class="tour-count">${this._tourIdx + 1}/${total}</span>
            ${isLast ? `<button class="tour-btn tour-btn-primary" onclick="app._endTour()">Got it!</button>` : `<button class="tour-btn tour-btn-primary" onclick="app._nextTour()">Next</button>`}
            <button class="tour-btn" onclick="app._endTour()">Skip</button>
          </div>
        </div>`;
      } else {
        this._tourIdx++;
        this._showTourStep();
        return;
      }
    } else {
      // Center message (no target)
      overlay.innerHTML = `<div class="tour-tip tour-center">
        <div class="tour-text">${step.text}</div>
        <div class="tour-nav">
          <button class="tour-btn tour-btn-primary" onclick="app._endTour()">Start reading!</button>
        </div>
      </div>`;
    }

    document.body.appendChild(overlay);
  }

  _nextTour() { this._tourIdx++; this._showTourStep(); }
  _endTour() { document.getElementById('tourOverlay')?.remove(); localStorage.setItem('pbook-tour-done', '1'); }

  // ===== TEXT SIMILARITY (TF-IDF-like) =====
  _buildSimilarityIndex() {
    if (this._simIndex) return;
    const STOP = new Set('the a an is are was were be been being have has had do does did will would shall should may might can could of in to for on with at by from as into through during before after above below between out off over under again further then once here there when where why how all both each few more most other some such no nor not only own same so than too very i me my we our you your he him his she her it its they them their what which who whom this that these those am'.split(' '));

    // Extract key terms per block
    this._blockTerms = {};
    const docFreq = {}; // how many blocks contain each term
    const N = this.allBlocks.length;

    this.allBlocks.forEach(b => {
      if (b.meta.type !== 'spine') return;
      const text = ((b.meta.title || '') + ' ' + (b.body || '')).toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
      const words = text.split(/\s+/).filter(w => w.length > 3 && !STOP.has(w));
      // Term frequency
      const tf = {};
      words.forEach(w => { tf[w] = (tf[w] || 0) + 1; });
      this._blockTerms[b.meta.id] = tf;
      // Document frequency
      Object.keys(tf).forEach(w => { docFreq[w] = (docFreq[w] || 0) + 1; });
    });

    // Compute TF-IDF vectors
    this._blockVectors = {};
    Object.entries(this._blockTerms).forEach(([id, tf]) => {
      const vec = {};
      Object.entries(tf).forEach(([term, count]) => {
        const idf = Math.log(N / (docFreq[term] || 1));
        if (idf > 0.5) vec[term] = count * idf; // skip very common terms
      });
      this._blockVectors[id] = vec;
    });

    this._simIndex = true;
  }

  _cosineSim(vecA, vecB) {
    let dot = 0, normA = 0, normB = 0;
    for (const k in vecA) { normA += vecA[k] * vecA[k]; if (vecB[k]) dot += vecA[k] * vecB[k]; }
    for (const k in vecB) { normB += vecB[k] * vecB[k]; }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
  }

  _findSimilarBlocks(blockId, count) {
    this._buildSimilarityIndex();
    const vec = this._blockVectors[blockId];
    if (!vec) return [];

    // Also add topic overlap bonus
    const blockTopics = this.blockTopics[blockId] || [];

    const scored = [];
    this.allBlocks.forEach(b => {
      if (b.meta.id === blockId || b.meta.type !== 'spine') return;
      const bVec = this._blockVectors[b.meta.id];
      if (!bVec) return;
      let sim = this._cosineSim(vec, bVec);
      // Bonus for topic overlap
      const bTopics = this.blockTopics[b.meta.id] || [];
      const topicOverlap = blockTopics.filter(t => bTopics.includes(t)).length;
      sim += topicOverlap * 0.15;
      scored.push({ id: b.meta.id, title: b.meta.title, chNum: b.meta._chapterNum, sim });
    });

    scored.sort((a, b) => b.sim - a.sim);
    return scored.slice(0, count).filter(s => s.sim > 0.05);
  }

  // ===== VIEW SWITCHING =====
  switchView(view, auto) {
    this.currentView = view;
    const modeMap = { home: 'netflix', read: 'read', map: 'map', glossary: 'mission', quiz: 'quiz', chat: 'tutor', profile: 'profile' };
    this.rc.setContext(modeMap[view] || view);
    // Only log mode_switch for explicit user navigation, not automatic transitions
    if (!auto) this.rc.logEvent('mode_switch', { mode: modeMap[view] || view, from: this._prevView });
    this._prevView = view;

    // Hide all views, show the selected one
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    const viewEl = document.getElementById(`view-${view}`);
    if (viewEl) viewEl.classList.add('active');

    // Update tab highlights
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === view));
    // Clear hash to prevent deep-link re-triggering on tab click
    if (!auto && window.location.hash) history.replaceState(null, '', window.location.pathname);

    // Linear nav only in read view

    if (view === 'home') this.renderHome();
    else if (view === 'read') this.renderRead();
    else if (view === 'map') this.renderMap();
    else if (view === 'glossary') { if (this._f('missions')) this.renderMissions(); else this.switchView('home'); }
    else if (view === 'quiz') this.renderQuiz();
    else if (view === 'chat') this.initChatView();
    else if (view === 'profile') this.renderProfile();
    window.scrollTo(0, 0);
  }

  // ===== HOME VIEW (Netflix shelves) =====
  async renderHome() {
    const el = document.getElementById('homeContent');
    let html = '';

    // 1. Continue reading (hero)
    const continueBlock = this.getContinueBlock();
    if (continueBlock) {
      html += this.shelf('Continue reading', [this.cardHtml(continueBlock, true)]);
    }

    // Recall cards — show due + almost due (within 30 min)
    if (this._f('spaceRepetition')) {
      const now = Date.now();
      const soonThreshold = 30 * 60 * 1000; // 30 minutes
      const dueAndSoon = Object.entries(this.user.recall)
        .filter(([_, c]) => c.nextReview <= now + soonThreshold)
        .sort((a, b) => a[1].nextReview - b[1].nextReview)
        .map(([blockId, card]) => ({ blockId, ...card }));
      if (dueAndSoon.length > 0) {
        const recallCards = dueAndSoon.slice(0, 8).map(r => this._recallCardHtml(r)).filter(Boolean);
        if (recallCards.length) html += this.shelf(`\u{1F9E0} Do you remember? (${recallCards.length})`, recallCards);
      }
    }

    // Active missions (guarded)
    if (!this._f('missions')) { /* skip missions shelf */ } else {
    const missions = this.getMissions();
    const activeMissions = missions.filter(m => {
      if (this._isMissionLocked(m)) return false;
      const p = this._getMissionProgress(m);
      return p.read > 0 && !((this.user.completedMissions || []).includes(m.id));
    });
    const nextMission = missions.find(m => !this._isMissionLocked(m) && this._getMissionProgress(m).read === 0);
    const missionCards = [...activeMissions, ...(nextMission ? [nextMission] : [])].slice(0, 4).map(m => {
      const coreRead = m.core.filter(id => this.user.readBlocks.has(id)).length;
      const isNext = coreRead === 0;
      return `<div class="card" style="border-top: 3px solid var(--accent); flex: 0 0 240px; cursor:pointer" onclick="app.showMission('${m.id}')">
        <div class="card-chapter" style="color:var(--accent);font-weight:700">${isNext ? 'Next mission' : 'In progress'}</div>
        <div style="font-size:1.3rem;margin:.1em 0">${m.icon}</div>
        <div class="card-title">${m.title}</div>
        <div class="mission-progress-dots" style="margin:.3em 0">${m.core.map((id, i) => `<span class="mission-dot ${this.user.readBlocks.has(id) ? 'done' : i === coreRead ? 'current' : ''}"></span>`).join('')}</div>
        <div class="card-meta"><span class="card-time">${coreRead}/${m.core.length} steps</span></div>
      </div>`;
    });
    if (missionCards.length) html += this.shelf('Your missions', missionCards);
    } // end missions guard

    // Core essentials — unread core blocks
    const unreadCore = this.allBlocks.filter(b => b.meta.core && b.meta.type === 'spine' && !this.user.readBlocks.has(b.meta.id)).slice(0, 10);
    if (unreadCore.length) {
      html += this.shelf('Essential reading', unreadCore.map(b => this.cardHtml(b.meta)));
    }

    // 2. Recommended for you (Recombee scenario: homepage-personal)
    const forYou = await this.rc.getRecsForUser('homepage-personal', 8, this.rc.reql({ type: 'spine' }), this.rc.reqlBoost(this.user));
    if (forYou?.recomms?.length) {
      const forYouCards = forYou.recomms.map(r => this.cardFromRec(r)).filter(Boolean);
      if (forYouCards.length) html += this.shelf('Picked for you', forYouCards);
    }

    // 3. Matching your interest (Recombee scenario: homepage-voice)
    const topVoice = this.user.getTopVoice();
    if (topVoice) {
      const voiceLabel = CONFIG.voices[topVoice]?.label || topVoice;
      const voiceRecs = await this.rc.getRecsForUser('homepage-voice', 8, this.rc.reql({ voice: [topVoice] }));
      const voiceCards = voiceRecs?.recomms?.length ? voiceRecs.recomms.map(r => this.cardFromRec(r)).filter(Boolean) : [];
      if (voiceCards.length) {
        html += this.shelf(`${voiceLabel} picks`, voiceCards);
      } else {
        const voiceBlocks = this.allBlocks.filter(b => b.meta.voice === topVoice && b.meta.type === 'spine' && !this.user.readBlocks.has(b.meta.id)).slice(0, 10);
        if (voiceBlocks.length) html += this.shelf(`${voiceLabel} picks`, voiceBlocks.map(b => this.cardHtml(b.meta)));
      }
    }

    // 4. Quick reads
    const quickReads = this.allBlocks.filter(b => b.meta.type === 'spine' && b.meta.standalone && !this.user.readBlocks.has(b.meta.id)).slice(0, 10);
    if (quickReads.length) {
      html += this.shelf('Quick reads', quickReads.map(b => this.cardHtml(b.meta)));
    }

    // 5. Liked items (if any)
    const liked = [...this.user.ratings].filter(([_, r]) => r >= 0.7).map(([id]) => this.findBlock(id)).filter(Boolean);
    if (liked.length) {
      html += this.shelf('&#10084; Your liked', liked.reverse().map(b => this.cardHtml(b.meta)));
    }

    // 6. Saved items (if any)
    const saved = [...this.user.savedBlocks].map(id => this.findBlock(id)).filter(Boolean);
    if (saved.length) {
      html += this.shelf('&#128278; Saved for later', saved.reverse().map(b => this.cardHtml(b.meta)));
    }

    // 7. Topic carousels (pick top 3 topics user hasn't explored much)
    const topicEntries = Object.entries(this.topicIndex).filter(([_, ids]) => ids.length >= 3).sort((a, b) => b[1].length - a[1].length);
    const shownTopics = new Set();
    topicEntries.slice(0, 6).forEach(([topic, ids]) => {
      if (shownTopics.size >= 3) return;
      const topicBlocks = ids.map(id => this.findBlock(id)).filter(Boolean).slice(0, 10);
      if (topicBlocks.length >= 3) {
        html += this.shelf(topic, topicBlocks.map(b => this.cardHtml(b.meta)));
        shownTopics.add(topic);
      }
    });

    // 8. By chapter (unread first)
    this.book.chapters.forEach((ch, i) => {
      const allSpines = (this.chapters[i]?.blocks || []).filter(b => b.type === 'spine');
      const unread = allSpines.filter(b => !this.user.readBlocks.has(b.id));
      const read = allSpines.filter(b => this.user.readBlocks.has(b.id));
      const chBlocks = [...unread, ...read].slice(0, 8);
      if (chBlocks.length) {
        html += this.shelf(`Ch${ch.number}: ${ch.title}`, chBlocks.map(b => this.cardHtml(b)));
      }
    });

    el.innerHTML = html || '<div class="search-empty">Loading content...</div>';
    // Update arrows multiple times to catch layout settling
    this._updateShelfArrows();
    setTimeout(() => this._updateShelfArrows(), 200);
    setTimeout(() => this._updateShelfArrows(), 600);
  }

  shelf(title, cardHtmls) {
    const id = 'shelf-' + (this._shelfCounter = (this._shelfCounter || 0) + 1);
    return `<section class="shelf fade-up">
      <div class="shelf-head"><h3 class="shelf-title">${title}</h3></div>
      <div class="shelf-wrap">
        <button class="shelf-btn shelf-btn-left arrow-hidden" onclick="app.scrollShelf('${id}',-1)">&#8249;</button>
        <div class="shelf-scroll" id="${id}">${cardHtmls.join('')}</div>
        <button class="shelf-btn shelf-btn-right arrow-hidden" onclick="app.scrollShelf('${id}',1)">&#8250;</button>
      </div>
    </section>`;
  }

  scrollShelf(id, dir) {
    const el = document.getElementById(id);
    if (!el) return;
    el.scrollBy({ left: dir * 300, behavior: 'smooth' });
    // Update arrows after scroll animation
    setTimeout(() => {
      const wrap = el.closest('.shelf-wrap');
      if (wrap) this._updateArrowVisibility(wrap, el);
    }, 350);
  }

  // Show/hide shelf arrows based on scroll position
  _updateShelfArrows() {
    document.querySelectorAll('.shelf-wrap').forEach(wrap => {
      const scroll = wrap.querySelector('.shelf-scroll');
      if (!scroll) return;
      const overflows = scroll.scrollWidth > scroll.clientWidth + 10;
      wrap.classList.toggle('no-scroll', !overflows);
      if (!overflows) {
        // No overflow: hide both arrows completely
        wrap.querySelectorAll('.shelf-btn').forEach(b => b.classList.add('arrow-hidden'));
      } else {
        this._updateArrowVisibility(wrap, scroll);
      }
    });
    // Listen for scroll to update arrows dynamically
    document.querySelectorAll('.shelf-scroll').forEach(scroll => {
      if (scroll.dataset.arrowBound) return;
      scroll.dataset.arrowBound = '1';
      scroll.addEventListener('scroll', () => {
        const wrap = scroll.closest('.shelf-wrap');
        if (wrap) this._updateArrowVisibility(wrap, scroll);
      }, { passive: true });
    });
  }

  _updateArrowVisibility(wrap, scroll) {
    const left = wrap.querySelector('.shelf-btn-left');
    const right = wrap.querySelector('.shelf-btn-right');
    if (!left || !right) return;
    // scrollLeft can be offset by padding/snap — use generous threshold
    const sl = Math.round(scroll.scrollLeft);
    const pad = parseFloat(getComputedStyle(scroll).paddingLeft) || 16;
    const canScrollLeft = sl > pad + 2;
    const canScrollRight = sl + scroll.clientWidth < scroll.scrollWidth - pad - 2;
    left.classList.toggle('arrow-hidden', !canScrollLeft);
    right.classList.toggle('arrow-hidden', !canScrollRight);
  }

  cardHtml(block, hero = false) {
    const chLabel = block._chapterTitle || this.getChapterLabel(block);
    const isRead = this.user.readBlocks.has(block.id);
    const badge = block.type === 'depth' ? `<span class="card-badge ${block.voice}">${CONFIG.voices[block.voice]?.label || block.voice}</span>` : '';
    const teaser = block.teaser ? `<div class="card-teaser">${block.teaser}</div>` : '';

    // Visual preview strip: detect content type from body
    const fullBlock = this.findBlock(block.id);
    const body = fullBlock?.body || block.body || '';
    const hasMath = /\$\$/.test(body);
    const hasTable = /^\|/m.test(body);
    const hasDiagram = !!block.diagram;
    const hasCode = /```/.test(body);

    let preview = '';
    if (hasDiagram || hasMath || hasTable || hasCode) {
      const tags = [];
      if (hasDiagram) tags.push('<span class="card-tag tag-diagram">&#128202; Diagram</span>');
      if (hasMath) tags.push('<span class="card-tag tag-math">&#8721; Math</span>');
      if (hasTable) tags.push('<span class="card-tag tag-table">&#9638; Table</span>');
      if (hasCode) tags.push('<span class="card-tag tag-code">&lt;/&gt; Code</span>');
      preview = `<div class="card-tags">${tags.join('')}</div>`;
    }

    // Voice-colored top border for depth cards
    const borderStyle = block.type === 'depth' && block.voice ? `border-top: 3px solid var(--${block.voice})` : '';

    // Topic tags
    const topics = (this.blockTopics[block.id] || []).slice(0, 2);
    const topicHtml = topics.length ? `<div class="card-topics">${topics.map(t => `<span class="card-topic" onclick="event.stopPropagation();app.showTopic('${t}')">${t}</span>`).join('')}</div>` : '';

    return `<div class="card ${hero ? 'card-hero' : ''} ${isRead ? 'card-read' : ''}" style="${borderStyle}" onclick="app.openBlock('${block.id}')">
      ${preview}
      <div class="card-chapter">${chLabel}</div>
      <div class="card-title">${block.title}</div>
      ${teaser}
      ${topicHtml}
      <div class="card-meta">${badge}<span class="card-time">${block.readingTime || 3} min</span></div>
    </div>`;
  }

  cardFromRec(rec) {
    const block = this.findBlock(rec.id);
    if (block) return this.cardHtml(block.meta);
    return ''; // skip items that don't exist in the current book
  }

  getContinueBlock() {
    // Find next unread spine block after last read position
    for (let ci = this.user.currentChapter; ci < this.book.chapters.length; ci++) {
      const ch = this.chapters[ci];
      if (!ch) continue;
      const spines = ch.blocks.filter(b => b.type === 'spine');
      const next = spines.find(b => !this.user.readBlocks.has(b.id));
      if (next) return next;
    }
    return null;
  }

  // ===== READ VIEW (infinite scroll) =====
  async renderRead(chapterIdx) {
    const idx = chapterIdx !== undefined ? chapterIdx : this.user.currentChapter;
    const ch = this.chapters[idx];
    if (!ch) return;
    this.user.currentChapter = idx;
    this.user.save();

    const pane = document.getElementById('readPane');

    // Reset observer for fresh render
    if (this._observer) { this._observer.disconnect(); this._observer = null; }
    if (this._dwellTimers) { Object.values(this._dwellTimers).forEach(t => clearInterval(t)); this._dwellTimers = {}; }
    this._observedChapters = {};

    // Render current chapter
    const html = await this._renderChapterContent(ch, idx);
    pane.innerHTML = html;
    this._renderedChapter = idx;
    this._loadedChapters = new Set([idx]);

    // Set up infinite scroll — load more content when near bottom
    this._setupInfiniteScroll(pane, idx);

    // Scroll: if pending scroll (from openBlock), go to that block; otherwise top
    if (this._pendingScroll) {
      this._scrollToBlock(this._pendingScroll.parentId, this._pendingScroll.meta);
      this._pendingScroll = null;
    } else {
      window.scrollTo(0, 0);
    }

    // Render math, observe blocks
    this.renderMath();
    this._observeBlocks(ch);
    this._updateMissionBar();
    this._showMissionIntro();
  }

  async _renderChapterContent(ch, idx) {
    let html = `<div class="ch-head fade-up" id="ch-head-${idx}"><div class="ch-label">Chapter ${ch.number}</div><h2>${ch.title}</h2><div class="ch-sub">${ch.subtitle}</div></div>`;

    let spineCount = 0;
    for (const block of ch.blocks) {
      if (block.type === 'spine') {
        html += await this.renderSpine(block);
        spineCount++;
        // Insert inline quiz every 2-3 spine blocks
        if (spineCount % 3 === 0) {
          const quizHtml = this._generateQuiz(block);
          if (quizHtml) html += `<div class="inline-quiz fade-up">${quizHtml}</div>`;
        }
      } else if (block.type === 'question') {
        html += this.renderQuestion(block);
      } else if (block.type === 'game' && this._f('games')) {
        html += this.renderGame(block);
      }
    }
    return html;
  }

  _setupInfiniteScroll(pane, startIdx) {
    if (this._scrollHandler) window.removeEventListener('scroll', this._scrollHandler);
    this._isLoadingMore = false;
    this._feedShownBlocks = new Set(this.chapters[startIdx]?.blocks.map(b => b.id) || []);

    this._scrollHandler = async () => {
      if (this._isLoadingMore || this.currentView !== 'read') return;
      const scrollBottom = window.innerHeight + window.scrollY;
      const docHeight = document.documentElement.scrollHeight;
      if (scrollBottom < docHeight - 600) return;

      this._isLoadingMore = true;
      const nextBlocks = await this._getNextFeedBlocks(3);
      if (nextBlocks.length) {
        for (const block of nextBlocks) {
          if (this._feedShownBlocks.has(block.meta.id)) continue;
          this._feedShownBlocks.add(block.meta.id);
          const ch = this.chapters[block.meta._chapterIdx];
          // Chapter divider if different chapter
          const lastCh = this._lastFeedChapter;
          if (ch && ch.id !== lastCh) {
            pane.insertAdjacentHTML('beforeend', `<div class="feed-ch-divider fade-up"><span>Ch${ch.number}: ${ch.title}</span></div>`);
            this._lastFeedChapter = ch.id;
          }
          const html = block.meta.type === 'game' ? this.renderGame(block.meta) : await this.renderSpine(block.meta);
          pane.insertAdjacentHTML('beforeend', html);
          // Observe for dwell tracking
          if (ch) {
            if (!this._observedChapters[block.meta.id]) this._observedChapters[block.meta.id] = ch;
            const el = document.getElementById(`b-${block.meta.id}`);
            if (el && !el.dataset.observed) { el.dataset.observed = '1'; this._observer?.observe(el); }
          }
        }
        this.renderMath();
      }
      this._isLoadingMore = false;
    };

    this._lastFeedChapter = this.chapters[startIdx]?.id;
    window.addEventListener('scroll', this._scrollHandler, { passive: true });
  }

  async _getNextFeedBlocks(count) {
    const shown = this._feedShownBlocks || new Set();
    let blocks = [];

    // Try Recombee for personalized recommendations
    if (this.rc.enabled && this._f('personalization')) {
      const result = await this.rc.getRecsForUser('next-read', count * 3, this.rc.reql({ type: 'spine' }), this.rc.reqlBoost(this.user));
      if (result?.recomms?.length) {
        for (const r of result.recomms) {
          if (shown.has(r.id)) continue;
          const block = this.findBlock(r.id);
          if (block) { blocks.push(block); if (blocks.length >= count) break; }
        }
      }
    }

    // Fallback: sequential not-yet-shown blocks, voice-preferred, unread first
    if (blocks.length < count) {
      const voice = this.user.preferredVoice;
      const candidates = this.allBlocks.filter(b =>
        (b.meta.type === 'spine' || (b.meta.type === 'game' && this._f('games'))) &&
        !shown.has(b.meta.id) && !blocks.find(x => x.meta.id === b.meta.id)
      );
      // Sort: unread first, then by voice preference
      candidates.sort((a, b) => {
        const aRead = this.user.readBlocks.has(a.meta.id) ? 1 : 0;
        const bRead = this.user.readBlocks.has(b.meta.id) ? 1 : 0;
        if (aRead !== bRead) return aRead - bRead;
        if (voice && voice !== 'universal') {
          const av = a.meta.voice === voice ? 0 : a.meta.voice === 'universal' ? 1 : 2;
          const bv = b.meta.voice === voice ? 0 : b.meta.voice === 'universal' ? 1 : 2;
          return av - bv;
        }
        return 0;
      });
      for (const b of candidates) {
        blocks.push(b);
        if (blocks.length >= count) break;
      }
    }

    return blocks;
  }

  // (moved inline to renderRead)

  _observeBlocks(ch) {
    // Dwell-time tracking: seen after 3s visible, read after estimated reading time
    // Create observer once; on subsequent calls just observe new elements
    if (!this._observer) {
      this._dwellTimers = {};
      this._observedChapters = {};
    }
    // Store chapter blocks for lookup
    ch.blocks.forEach(b => { this._observedChapters[b.id] = ch; });

    if (!this._observer) {
    this._observer = new IntersectionObserver((entries) => {
      entries.forEach(e => {
        const id = e.target.id?.replace('b-', '');
        if (!id) return;

        if (e.isIntersecting) {
          // Start dwell timer — find block from any loaded chapter
          const ownerCh = this._observedChapters[id];
          const block = ownerCh ? ownerCh.blocks.find(b => b.id === id) : null;
          const readTimeMs = Math.min(((block?.readingTime || 2) * 60 * 1000) * 0.15, 12000); // 15% of reading time, max 12s — kids read fast!
          const startTime = Date.now();

          this._dwellTimers[id] = setInterval(() => {
            const elapsed = Date.now() - startTime;

            // After 3s: mark as "seen" + update sidebar context
            if (elapsed >= 3000 && !this.user.seenBlocks.has(id)) {
              this.user.trackSeen(id);
              this.rc.sendView(id, Math.round(elapsed / 1000));
              e.target.querySelector('.block-status')?.classList.add('seen');
              this._lastVisibleBlock = id;
              // context panel removed
            }

            // After reading time: mark as "read"
            if (elapsed >= readTimeMs && !this.user.readBlocks.has(id)) {
              this.user.trackRead(id);
              this.rc.sendView(id, Math.round(elapsed / 1000));
              e.target.querySelector('.block-status')?.classList.remove('seen');
              e.target.querySelector('.block-status')?.classList.add('read');
              // context panel removed
              this._updateInlineReadNext(id, ownerCh);
              this._insertInlineRecall(id);
              this.showXPToast('+10 XP', 'xp');
              this.checkGamificationEvents();
              this._updateMissionBar();
              clearInterval(this._dwellTimers[id]);
            }

            // Track dwell every 5s
            if (elapsed % 5000 < 1100) {
              this.user.trackDwell(id, 5000);
            }
          }, 1000);

        } else {
          // Block left viewport: stop timer
          if (this._dwellTimers[id]) {
            clearInterval(this._dwellTimers[id]);
            delete this._dwellTimers[id];
          }
        }
      });
    }, { threshold: 0.3 });
    } // end if (!this._observer)

    // Observe all block articles (new ones will just be added)
    document.querySelectorAll('.block-article').forEach(el => {
      if (!el.dataset.observed) {
        el.dataset.observed = '1';
        this._observer.observe(el);
      }
    });
  }

  // Generate AI highlights/takeaways from block content
  _getHighlights(block) {
    const body = (block.body || '').toLowerCase();
    const id = block.id;
    // Hand-crafted key takeaways for core blocks
    const HIGHLIGHTS = {
      // ── Chapter 1: What Are Recommendations? ──
      'ch1-noticed': ['Your feed is unique — nobody else sees the same thing', 'Algorithms decide what you see based on everything you do', 'Every app personalizes differently using math and data'],
      'ch1-everywhere': ['Recommendations hide in 8+ apps: YouTube, TikTok, Spotify, Netflix, App Store, Amazon...', 'You see hundreds of recommendations per day without realizing', 'Once you learn to spot them, you\'ll see them everywhere'],
      'ch1-not-magic': ['It\'s detective work: watch → find patterns → predict', 'More data = smarter system (more clues to work with)', 'Compare you to millions of people to find what you\'ll like'],
      'ch1-wrong-sidebar': ['One video can flood your feed — the system over-reacts', 'Recommendations help YOU find things; ads help COMPANIES sell things', 'Both use data, but their goals are completely different'],
      'ch1-patterns-d-think': ['Pattern-finding is everywhere: nature, science, games — and algorithms', 'Machines spot patterns across millions of people that no human could', 'Danger: some patterns look real but are just coincidences'],
      'ch1-three-jobs': ['Job 1: DISCOVER — find things you didn\'t know existed', 'Job 2: FIND — locate what you want in massive catalogs', 'Job 3: ENGAGE — keep you interested (helpful but risky)'],
      'ch1-wyr': ['Better recs require more data → more data means less privacy', 'Surprise vs. accuracy: safe picks or risky discoveries?', 'No perfect answer — every choice has a trade-off'],
      'ch1-ws-match': ['5 models: friend-based, follow-based, interest-based, algorithm-based, group-based', 'Most apps now use hybrids (follow + algorithm together)', 'Algorithm-based = app controls; follow-based = YOU control'],
      // ── Chapter 2: How They Learn About You ──
      'ch2-footprints': ['Every click, watch, skip, and search = a digital footprint', 'You\'re constantly teaching the system without realizing', 'The system starts as a stranger but learns to know you better than friends'],
      'ch2-track-d-exp': ['Sneaky signals: watch speed, hover time, pauses, scroll patterns', 'Finishing a video ≫ clicking and leaving (watch time is king)', 'Signal strength: buying > rewatching > liking > clicking > hovering'],
      'ch2-guess-signal': ['Actions requiring effort (search, share) = strongest signals', 'Sharing = strongest signal — you chose to show it to someone', 'Passive actions like scrolling are weak and ambiguous'],
      'ch2-clues': ['Three clue types: what items ARE, who YOU are, what you DO', 'Your actions reveal who you really are — better than words', 'All three together make recommendations work; missing one = worse recs'],
      'ch2-incognito-sidebar': ['New accounts = cold start problem: zero info about you', 'System shows popular stuff to everyone until it learns who you are', 'Picking interests on signup helps skip ahead and learn faster'],
      'ch2-myth': ['Your phone doesn\'t listen — it reads your clicks, searches, messages', 'One weird video won\'t ruin your feed forever (recent behavior wins)', 'You can deliberately train the algorithm on purpose'],
      'ch2-privacy': ['5 data superpowers: "Not Interested," clear history, separate profiles, incognito, settings', 'Data is a trade: your info for better recommendations', 'You\'re in control — you can always change things'],
      'ch2-privacy-d-create': ['Clear history + watch 5-10 videos = algorithm reshapes fast', 'The system over-reacts to new topics (2 cooking videos → cooking flood)', 'Great experiment: watch something new and observe the feed change'],
      'ch2-ws-detective': ['Check recs → tap "Not Interested" → watch the feed adjust instantly', 'One new video reshapes your feed in real time', 'You either train the algorithm on purpose or it happens to you'],
      // ── Chapter 3: Different Ways to Recommend ──
      'ch3-friends': ['Collaborative filtering: find taste twins → recommend what THEY liked', 'No need to describe what you like — similar users do it for you', '"People who liked X also liked Y" — simple but powerful'],
      'ch3-cf-d-exp': ['Find taste twins: people who liked the same movies as you', 'Check what your twins liked that you haven\'t tried → that\'s the rec', 'Netflix, Spotify, YouTube all work this way at massive scale'],
      'ch3-cf-d-create': ['You can build collaborative filtering with pencil + paper', 'More people + more items = better predictions', 'Real platforms use the exact same logic but with millions of users'],
      'ch3-netflix-sidebar': ['Netflix Prize: better algorithms don\'t win if they\'re too slow', 'Speed and simplicity often beat perfect accuracy', 'The competition changed the field even though the winner\'s solution wasn\'t used'],
      'ch3-content': ['Content-based: analyze what items ARE (genre, tags, tempo, description)', 'Solves cold start — works for brand new items with zero ratings', 'Doesn\'t need other users — just item data'],
      'ch3-compare-d-think': ['Collaborative = surprising recs but fails with new items (cold start)', 'Content-based = works instantly but can create filter bubbles', 'Best systems use BOTH — hybrid approach for different situations'],
      'ch3-spot-method': ['Trending = popularity. "Because you watched" = content-based', '"Fans also listen to" = collaborative filtering', 'Real apps mix multiple methods together'],
      'ch3-bandits': ['Explore-exploit dilemma: safe picks vs. risky discoveries', 'Bandit algorithms balance both by learning success rates over time', 'Context matters: what you want at 8am ≠ Friday night'],
      'ch3-deep-similarity': ['Embeddings: items become lists of numbers (vectors) in similarity space', 'Neural networks learn hidden qualities that simple tags miss', 'Close vectors = similar items — solves cold start with math, not ratings'],
      'ch3-popular': ['Simplest method: just show what everyone\'s watching right now', 'Works for new users with zero data + culturally relevant', 'No personalization — treats everyone identically'],
      'ch3-popular-sidebar': ['Popularity = rich-get-richer: popular content stays on top forever', 'New creators get buried while hits keep winning', 'TikTok\'s testing pools give ALL content a fair first chance'],
      'ch3-pipeline': ['Real systems combine ALL methods in 3 stages: Find → Rank → Check', 'Stage 1 is fast + rough, Stage 2 is precise, Stage 3 adds diversity', 'The whole pipeline runs in under 1 second'],
      'ch3-pipeline-d-exp': ['Find: cast wide net (500 candidates). Rank: score each carefully. Check: filter for variety', 'The system never looks at all 800M videos — fast filters narrow it first', 'All three stages run in parallel for speed'],
      'ch3-speed': ['YouTube picks the best 20 from 800 million videos in 0.2 seconds', 'A human would need 25 YEARS to do what YouTube does in 1 second', 'Staged pipeline (rough → precise) makes the impossible possible'],
      'ch3-search-recs': ['Search results are personalized — what YOU see differs from others', 'Search suggestions use collaborative filtering + content similarity + popularity', 'Modern platforms run search and recs on the same engine'],
      // ── Chapter 4: Making Recommendations Better ──
      'ch4-bubbles': ['Filter bubble = only seeing what you already like', 'You never see what you\'re missing — the bubble is invisible', 'Good systems mix in surprises to balance comfort with discovery'],
      'ch4-echo-d-think': ['Echo chambers: different people see different realities about the same topic', 'During your opinion-forming years, multiple perspectives are crucial', 'Good systems show all sides and let YOU decide'],
      'ch4-experiment': ['Watch 3 cooking videos → your homepage visibly changes in minutes', 'You are an active TRAINER of the algorithm, not a passive victim', 'Exploring new content deliberately can break filter bubbles'],
      'ch4-fairness': ['Popularity creates rich-get-richer: popular → more visible → more popular', 'New creators stay invisible while hits keep winning', 'Solutions: exploration slots, freshness boosts, diversity rules'],
      'ch4-youtube-sidebar': ['70% of YouTube watch time comes from recommendations, not search', 'One algorithm change = billions of views shifted instantly', 'Even YouTube engineers can\'t fully explain every decision'],
      'ch4-unfair-game': ['Popular content gets recommended more → gets more popular → repeat', 'Good systems guarantee visibility for new content before judging it', 'Every voice should get heard, not just the loudest'],
      'ch4-objectives': ['Every algorithm optimizes for something: watch time, purchases, or satisfaction', 'Subscription (Netflix) = optimizes for YOU. Free (YouTube) = optimizes for ADS', 'Users, creators, and businesses all want different things'],
      'ch4-explainability': ['Neural networks use hundreds of signals — impossible to fully explain', '"Because you watched X" is often a simplified guess, not the real reason', 'EU law now requires platforms to explain their recommendations'],
      'ch4-testing': ['A/B tests: split users in two groups, change one thing, measure the difference', 'Measures real behavior, not guesses or opinions', 'The best teams measure long-term satisfaction, not just clicks'],
      'ch4-ab-d-exp': ['Personalized recs beat generic popular picks: 37% more songs, 4x more discovery', 'Simple systems are cheaper — engineers balance accuracy vs. cost', 'Long-term metrics matter more than short-term engagement'],
      // ── Chapter 5: Build Your Own! ──
      'ch5-start': ['Recommendation systems use simple logic: collect → find similar → predict → test', 'You can build one by hand with pencil and paper first', 'Understanding the system = you\'ll design better ones in the future'],
      'ch5-collect': ['Rating matrix: people as rows, items as columns, ratings in the cells', 'Empty cells = what the system needs to predict', 'Sparse data (mostly empty) is the fundamental challenge'],
      'ch5-spread-d-create': ['Spreadsheets scale the pencil-and-paper method to more data', 'Color-coded ratings reveal taste patterns visually', 'Each cell mirrors exactly what Netflix uses at massive scale'],
      'ch5-similar': ['Compare ratings on shared items → lower difference = more similar', '"Taste neighbors" are the foundation of collaborative filtering', 'Predict by averaging your most similar users\' ratings'],
      'ch5-math-d-think': ['Cosine similarity measures angle between preference vectors', 'Someone who rates everything low but in the SAME pattern = still similar', 'Real systems test multiple similarity measures to find the best one'],
      'ch5-real-numbers': ['Netflix: 3.4 trillion possible combinations. YouTube: 2.16 quintillion', 'These grids are mostly empty — the math trick is finding patterns in sparse data', 'Your 5-friend grid uses the same logic as Netflix\'s massive one'],
      'ch5-recommend': ['Find 2-3 most similar users who rated the item → average their ratings', 'Above 4 stars = recommend it. Below = skip it', 'Test your predictions against real ratings — are you within 1 star?'],
      'ch5-code-d-create': ['20 lines of Python = complete collaborative filtering algorithm', 'Code automates the manual process and scales to larger datasets', 'Tweak parameters like thresholds to experiment and improve'],
      'ch5-debug': ['Errors come from: weak taste twins, old data, context changes, mood shifts', 'Even Netflix is wrong 20-30% of the time — perfection isn\'t the goal', 'Ask "why was I wrong?" to improve one mistake at a time'],
      'ch5-improve': ['6 upgrades: more data, genres, freshness, anti-popularity bias, all interactions, A/B tests', 'More data is the single biggest improvement (more connections to discover)', 'Test each change individually to measure if it actually helps'],
      'ch5-career-sidebar': ['Recommendation engineer = real job at major companies', 'Requires: math (stats, linear algebra), Python, creativity, curiosity', 'Expanding into education, medicine, self-driving cars, personalized learning'],
      'ch5-get-recommended': ['Platforms reward: engagement rate > total views, strong first impressions, consistency', 'YouTube = watch time. TikTok = completion rate. Instagram = saves. Spotify = 30 seconds', 'Quality content is essential — optimization without quality is unsustainable'],
      'ch5-seo-algorithms': ['Search and recommendations are merging — there\'s no single "top rank" anymore', 'Help algorithms categorize you: clear titles, descriptions, tags, content graphs', 'Success formula: quality × discoverability'],
      // ── Chapter 6: Ethics and You ──
      'ch6-who-decides': ['Algorithms decide what you see — not humans, not editors, not your parents', '"What keeps you watching longest" ≠ "what\'s best for you"', 'Your generation understands these systems better than the adults who built them'],
      'ch6-rabbit-sidebar': ['Each recommended step feels small — but the accumulated path leads somewhere unexpected', 'Algorithms optimize for the NEXT video, not the whole session trajectory', 'Scroll back through your history to see the path you actually took'],
      'ch6-addictive': ['Infinite scroll, autoplay, notification badges = deliberate design choices', 'The system always has a perfect next item ready — no natural stopping point', '"Take a break" reminders exist, but the system still rewards engagement'],
      'ch6-control-d-create': ['Tools: time limits, disable autoplay, "Not Interested," separate accounts, search > scroll', 'The thumbnail test: pause and ask "do I actually WANT this?"', 'Goal isn\'t to quit apps — it\'s to use them on YOUR terms'],
      'ch6-dopamine-sidebar': ['Dopamine = anticipation + uncertainty (same as slot machines)', 'Unpredictable rewards keep you hooked — the system exploits this accidentally', 'Recognizing the dopamine urge is a superpower most adults don\'t have'],
      'ch6-adtech-vs-recs': ['Recommender = helps you within ONE app (Netflix, Spotify)', 'Adtech = tracks you across the ENTIRE internet to sell your attention', 'That shoe ad following you everywhere? Adtech, not recommendations'],
      'ch6-privacy-real': ['Apps track everything: watch timing, skip speed, hover time, mood patterns', 'Your data builds a "digital twin" — a math model of you without your name', 'The question isn\'t IF they collect data — it\'s whether you understand and consent'],
      'ch6-data-d-exp': ['Download your data: myactivity.google.com (Google), TikTok settings, Instagram', 'You can clean up: auto-delete old history to limit how far back algorithms remember', 'Most people are shocked at the volume and precision of stored data'],
      'ch6-age-sidebar': ['Algorithms can guess your age within 3-5 years from behavior alone', 'When you watch, how fast you scroll, music taste, meme preferences = age signals', '"Anonymous" data isn\'t anonymous when behavioral profiles are detailed enough'],
      'ch6-ai-future': ['Your generation is the first to grow up with algorithms', 'You\'ll either BUILD the next systems or REGULATE them as voters and lawmakers', 'The question: who will algorithms serve? Your generation decides'],
      'ch6-hard-d-think': ['Should algorithms show disagreement? Should kids get different algorithms?', 'Who defines "harmful"? When is transparency itself harmful?', 'No right answers — but thinking about these puts you ahead of most adults'],
      'ch6-law-sidebar': ['EU Digital Services Act: opt-out algorithms + transparency required', 'Technology moves faster than law — global companies exploit legal gaps', 'User knowledge from below is more effective than regulation from above'],
      'ch6-conversational': ['Conversational recs: ASK for what you want instead of scrolling', 'LLMs understand nuance but lack real-time personal data and inventory', 'The future: LLMs (language) + recommenders (data) working together'],
    };
    if (HIGHLIGHTS[id]) return HIGHLIGHTS[id];
    // Auto-generate from content: extract sentences with bold markers, skip tables/headings
    const lines = (block.body || '').split('\n').filter(l => !l.startsWith('|') && !l.startsWith('#') && !l.startsWith('---'));
    const sentences = lines.join(' ').split(/[.!?]\s/).filter(s => s.includes('**') || s.length > 40 && s.length < 150);
    if (sentences.length >= 2) return sentences.slice(0, 3).map(s => s.replace(/[*#_\[\]|]/g, '').trim());
    return null;
  }

  async renderSpine(block) {
    let bodyHtml = renderMarkdown(block.body);
    let diagramHtml = '';
    if (block.diagram) { const svg = await getDiagram(block.diagram); diagramHtml = `<div class="diagram-wrap">${svg}</div>`; }
    const isRead = this.user.readBlocks.has(block.id);
    const userNotes = this.getNotes(block.id);
    const highlights = CONFIG.features.highlights !== false ? this._getHighlights(block) : null;

    // Side notes — AI takeaways + user highlights/notes
    let sideHtml = '';
    const sideItems = [];
    if (highlights) highlights.forEach(h => sideItems.push({ text: h, type: 'ai' }));
    userNotes.forEach((n, i) => sideItems.push({ quote: n.quote, text: n.text, type: 'user', idx: i }));
    if (sideItems.length) {
      sideHtml = `<div class="block-side" id="side-${block.id}">`;
      sideItems.forEach(n => sideHtml += this._renderSideNote(block.id, n));
      sideHtml += '</div>';
    }

    const chNum = block._chapterNum || '?';
    const chTitle = block._chapterTitle || '';
    // Position within chapter
    const ch = this.chapters[block._chapterIdx];
    const chSpines = ch ? ch.blocks.filter(b => b.type === 'spine') : [];
    const posInCh = chSpines.findIndex(b => b.id === block.id) + 1;
    const totalInCh = chSpines.length;

    return `<article class="block-article fade-up" id="b-${block.id}">
      <div class="block-nav">
        <button class="bnav-back" onclick="app.goBack()" title="Go back">&larr;</button>
        <span class="bnav-ch" onclick="app.goToMapChapter(${block._chapterIdx})">Ch${chNum}</span>
        <span class="bnav-sep">&middot;</span>
        <span class="bnav-progress">${posInCh}/${totalInCh}</span>
        ${block.core ? '<span class="bnav-core">CORE</span>' : ''}
        <div class="block-status ${isRead ? 'read' : this.user.seenBlocks.has(block.id) ? 'seen' : ''}"></div>
      </div>
      <div class="block-header">
        <h3>${block.title}</h3>
        <div class="block-meta">
          <span>${block.readingTime || 3} min read</span>
        </div>
      </div>
      <div class="block-with-side">
        <div class="block-main">
          ${diagramHtml}
          <div class="spine-body">${bodyHtml}</div>
        </div>
        ${sideHtml}
      </div>
      <div class="block-footer">
        <div class="block-reactions" data-block="${block.id}">
          <button class="like-btn ${this.user.ratings.get(block.id)>=0.7?'liked':''}" onclick="app.toggleLike('${block.id}')">
            ${this.user.ratings.get(block.id)>=0.7?'&#10084;&#65039;':'&#9825;'}
            <span>${this.user.ratings.get(block.id)>=0.7?'Liked':'Like'}</span>
          </button>
        </div>
        <div class="block-actions">
          <button class="act-btn tutor-btn" onclick="app.askAboutBlock('${block.id}')" title="Ask the tutor">&#10067;</button>
          <button class="act-btn" onclick="app.toggleNote('${block.id}')" title="Add note">&#128221;</button>
          ${this.user.recall[block.id] ? `<button class="act-btn" onclick="app.showBlockRecall('${block.id}')" title="Test your memory">&#129504;</button>` : ''}
          <button class="act-btn ${this.user.savedBlocks.has(block.id)?'active':''}" onclick="app.saveBlock('${block.id}')" title="Save for later">&#128278;</button>
          <button class="act-btn share-btn" onclick="app.shareBlock('${block.id}')" title="Share">&#128279;</button>
          <button class="act-btn flag-btn" onclick="app.flagBlock('${block.id}')" title="Suggest edit to author">&#9873;</button>
        </div>
      </div>
      <div class="note-editor" id="note-${block.id}" style="display:none">
        <div class="note-quote-preview" id="note-quote-${block.id}" style="display:none"></div>
        <textarea placeholder="Your note on this section..." id="note-text-${block.id}"></textarea>
        <input type="hidden" id="note-edit-idx-${block.id}" value="-1">
        <div class="note-actions">
          <button class="note-save" onclick="app.saveNote('${block.id}')">Save note</button>
          <button class="note-cancel" onclick="app.toggleNote('${block.id}')">Cancel</button>
        </div>
      </div>
      <div class="flag-form" id="flag-${block.id}" style="display:none">
        <div class="flag-header">Suggest edit to author</div>
        <select id="flag-type-${block.id}">
          <option value="typo">Typo / formatting issue</option>
          <option value="unclear">Content is unclear</option>
          <option value="incorrect">Factual issue</option>
          <option value="suggestion">Content suggestion</option>
          <option value="missing">Something is missing</option>
        </select>
        <textarea id="flag-text-${block.id}" placeholder="Your feedback (private, only visible to authors)..."></textarea>
        <div class="note-actions">
          <button class="note-save" onclick="app.submitFlag('${block.id}')">Send to authors</button>
          <button class="note-cancel" onclick="app.flagBlock('${block.id}')">Cancel</button>
        </div>
      </div>
    </article>`;
  }

  // Notes system — multiple notes per block, each with optional quote
  getNotes(blockId) {
    try {
      const store = JSON.parse(localStorage.getItem('pbook-notes') || '{}');
      const val = store[blockId];
      if (!val) return [];
      // Backwards compat: old format was a single string
      if (typeof val === 'string') return [{ text: val, quote: '', ts: 0 }];
      return Array.isArray(val) ? val : [];
    } catch(e) { return []; }
  }
  _saveNotes(blockId, notesArr) {
    try {
      const store = JSON.parse(localStorage.getItem('pbook-notes') || '{}');
      if (notesArr.length) store[blockId] = notesArr;
      else delete store[blockId];
      localStorage.setItem('pbook-notes', JSON.stringify(store));
    } catch(e) {}
  }
  toggleNote(blockId) {
    const ed = document.getElementById(`note-${blockId}`);
    if (!ed) return;
    const visible = ed.style.display !== 'none';
    ed.style.display = visible ? 'none' : 'block';
    if (!visible) {
      // Reset editor for new note
      const textarea = ed.querySelector('textarea');
      const quotePreview = document.getElementById(`note-quote-${blockId}`);
      const idxInput = document.getElementById(`note-edit-idx-${blockId}`);
      if (idxInput) idxInput.value = '-1';
      if (textarea) { textarea.value = ''; textarea.focus(); }
      if (quotePreview) { quotePreview.style.display = 'none'; quotePreview.textContent = ''; }
    }
  }
  editUserNote(blockId, idx) {
    const notes = this.getNotes(blockId);
    const note = notes[idx];
    if (!note) return;
    const ed = document.getElementById(`note-${blockId}`);
    if (!ed) return;
    ed.style.display = 'block';
    const textarea = document.getElementById(`note-text-${blockId}`);
    const quotePreview = document.getElementById(`note-quote-${blockId}`);
    const idxInput = document.getElementById(`note-edit-idx-${blockId}`);
    if (textarea) { textarea.value = note.text || ''; textarea.focus(); }
    if (quotePreview && note.quote) { quotePreview.style.display = 'block'; quotePreview.textContent = `"${note.quote}"`; }
    else if (quotePreview) quotePreview.style.display = 'none';
    if (idxInput) idxInput.value = idx;
  }
  deleteUserNote(blockId, idx) {
    const notes = this.getNotes(blockId);
    notes.splice(idx, 1);
    this._saveNotes(blockId, notes);
    this._refreshSideNotes(blockId);
  }
  saveNote(blockId) {
    const text = document.getElementById(`note-text-${blockId}`)?.value?.trim() || '';
    const idxInput = document.getElementById(`note-edit-idx-${blockId}`);
    const editIdx = idxInput ? parseInt(idxInput.value) : -1;
    const quotePreview = document.getElementById(`note-quote-${blockId}`);
    const quote = quotePreview?.textContent?.replace(/^"|"$/g, '') || '';

    const notes = this.getNotes(blockId);
    if (editIdx >= 0 && editIdx < notes.length) {
      // Editing existing note
      if (text) { notes[editIdx].text = text; }
      else { notes.splice(editIdx, 1); } // empty = delete
    } else if (text || quote) {
      // New note
      notes.push({ quote: quote.substring(0, 200), text, ts: Date.now() });
      this.user.trackNote(blockId);
      if (this._f('gamification')) { this.user.addXP(3); this.user.save(); this.showXPToast('+3 XP note added'); this.updateXPBadge(); }
    }
    this._saveNotes(blockId, notes);
    this.toggleNote(blockId);
    this._refreshSideNotes(blockId);
  }
  _renderSideNote(blockId, n) {
    const icon = n.type === 'user' ? '\u{1F4DD}' : '\u{1F4CC}';
    const searchText = n.type === 'user' ? (n.quote || '') : n.text;
    const clickAttr = searchText ? ` onclick="app.scrollToHighlight('${blockId}','${searchText.substring(0, 60).replace(/'/g, "\\'").replace(/\n/g, ' ')}')"` : '';
    if (n.type === 'user') {
      const quoteHtml = n.quote ? `<span class="snote-quote">"${this.escHtml(n.quote)}"</span>` : '';
      const noteHtml = n.text ? `<span class="snote-text">${this.escHtml(n.text)}</span>` : '';
      return `<div class="snote snote-user"${clickAttr}><span class="snote-icon">${icon}</span><div class="snote-body">${quoteHtml}${noteHtml}</div><button class="snote-edit" onclick="event.stopPropagation();app.editUserNote('${blockId}',${n.idx})">edit</button><button class="snote-del" onclick="event.stopPropagation();app.deleteUserNote('${blockId}',${n.idx})">&times;</button></div>`;
    }
    return `<div class="snote snote-ai"${clickAttr}><span class="snote-icon">${icon}</span><span class="snote-text">${this.escHtml(n.text)}</span></div>`;
  }

  _refreshSideNotes(blockId) {
    const block = this.findBlock(blockId);
    if (!block) return;
    const userNotes = this.getNotes(blockId);
    const highlights = CONFIG.features.highlights !== false ? this._getHighlights(block.meta || block) : null;
    const sideItems = [];
    if (highlights) highlights.forEach(h => sideItems.push({ text: h, type: 'ai' }));
    userNotes.forEach((n, i) => sideItems.push({ quote: n.quote, text: n.text, type: 'user', idx: i }));

    let sideEl = document.getElementById(`side-${blockId}`);
    const article = document.getElementById(`b-${blockId}`);
    if (!article) return;

    if (!sideItems.length) {
      if (sideEl) sideEl.remove();
      return;
    }

    let html = '';
    sideItems.forEach(n => html += this._renderSideNote(blockId, n));

    if (sideEl) {
      sideEl.innerHTML = html;
    } else {
      const wrapper = article.querySelector('.block-with-side');
      if (wrapper) {
        sideEl = document.createElement('div');
        sideEl.className = 'block-side';
        sideEl.id = `side-${blockId}`;
        sideEl.innerHTML = html;
        wrapper.appendChild(sideEl);
      }
    }
  }

  // Flag/report system
  flagBlock(blockId) {
    const form = document.getElementById(`flag-${blockId}`);
    if (!form) return;
    form.style.display = form.style.display === 'none' ? 'block' : 'none';
  }
  submitFlag(blockId) {
    const type = document.getElementById(`flag-type-${blockId}`)?.value;
    const text = document.getElementById(`flag-text-${blockId}`)?.value?.trim();
    if (!text) return;
    try {
      const flags = JSON.parse(localStorage.getItem('pbook-flags') || '[]');
      flags.push({ blockId, type, text, timestamp: new Date().toISOString() });
      localStorage.setItem('pbook-flags', JSON.stringify(flags));
    } catch(e) {}
    this.flagBlock(blockId); // close form
    // Show confirmation
    const form = document.getElementById(`flag-${blockId}`);
    if (form) {
      form.style.display = 'block';
      form.innerHTML = '<div style="padding:.8em;color:var(--product);font-size:.85rem">Thanks! Your feedback has been recorded for the author.</div>';
      setTimeout(() => { form.style.display = 'none'; }, 2000);
    }
  }

  escHtml(s) { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  // ===== TEXT HIGHLIGHT & NOTE =====
  highlightSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    // Determine blockId from selection anchor before modifying DOM
    const article = sel.anchorNode?.parentElement?.closest('.block-article');
    const blockId = article?.id?.replace('b-', '');
    const text = sel.toString();
    try {
      const range = sel.getRangeAt(0);
      try {
        // Simple case: selection within one element
        const mark = document.createElement('mark');
        mark.className = 'user-highlight';
        range.surroundContents(mark);
      } catch (e) {
        // Complex case: selection spans multiple elements — use CSS highlight via extractContents
        const fragment = range.extractContents();
        const mark = document.createElement('mark');
        mark.className = 'user-highlight';
        mark.appendChild(fragment);
        range.insertNode(mark);
      }
    } catch (e) { /* final fallback: do nothing visually */ }
    if (blockId) {
      this._saveHighlight(blockId, text);
      this.rc.sendRating(blockId, 0.8);
      if (this._f('gamification')) { this.user.addXP(1); this.user.save(); this.showXPToast('+1 XP highlighted'); this.updateXPBadge(); }
    }
    sel.removeAllRanges();
    document.getElementById('highlightPopup').style.display = 'none';
  }

  highlightAndNote() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    const quote = sel.toString().trim();
    // Determine blockId from the selection BEFORE highlightSelection clears it
    const anchor = sel.anchorNode?.parentElement?.closest('.block-article');
    const blockId = anchor?.id?.replace('b-', '');
    this.highlightSelection();
    if (blockId) {
      const ed = document.getElementById(`note-${blockId}`);
      if (ed) {
        ed.style.display = 'block';
        const textarea = document.getElementById(`note-text-${blockId}`);
        const quotePreview = document.getElementById(`note-quote-${blockId}`);
        const idxInput = document.getElementById(`note-edit-idx-${blockId}`);
        if (idxInput) idxInput.value = '-1';
        if (quotePreview && quote) { quotePreview.style.display = 'block'; quotePreview.textContent = `"${quote.substring(0, 200)}"`; }
        if (textarea) { textarea.value = ''; textarea.focus(); }
      }
    }
  }

  _saveHighlight(blockId, text) {
    try {
      const hl = JSON.parse(localStorage.getItem('pbook-highlights') || '{}');
      if (!hl[blockId]) hl[blockId] = [];
      hl[blockId].push({ text: text.substring(0, 200), ts: Date.now() });
      localStorage.setItem('pbook-highlights', JSON.stringify(hl));
    } catch (e) {}
  }

  scrollToHighlight(blockId, searchText) {
    if (!searchText) return;
    const article = document.getElementById(`b-${blockId}`);
    if (!article) return;
    const body = article.querySelector('.spine-body');
    if (!body) return;

    // 1. Try to find an existing <mark> that contains this text
    const marks = body.querySelectorAll('mark.user-highlight');
    for (const mark of marks) {
      if (mark.textContent.includes(searchText.substring(0, 30))) {
        mark.scrollIntoView({ behavior: 'smooth', block: 'center' });
        mark.classList.add('highlight-flash');
        setTimeout(() => mark.classList.remove('highlight-flash'), 1500);
        return;
      }
    }

    // 2. Fallback: find text in body via TreeWalker and wrap it temporarily
    const needle = searchText.substring(0, 60).toLowerCase();
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const idx = node.textContent.toLowerCase().indexOf(needle);
      if (idx === -1) continue;
      // Wrap the matched portion in a temporary highlight
      const range = document.createRange();
      range.setStart(node, idx);
      range.setEnd(node, Math.min(idx + searchText.length, node.textContent.length));
      const mark = document.createElement('mark');
      mark.className = 'user-highlight highlight-flash';
      try {
        range.surroundContents(mark);
        mark.scrollIntoView({ behavior: 'smooth', block: 'center' });
        // Remove the temporary mark after the flash
        setTimeout(() => {
          const parent = mark.parentNode;
          parent.replaceChild(document.createTextNode(mark.textContent), mark);
          parent.normalize();
        }, 2000);
      } catch(e) { /* range spans elements */ }
      return;
    }
  }

  // ===== MINI-GAMES (data-driven from games/*.json) =====
  renderGame(block) {
    const gameFile = block.game || block.gameType || block.id;
    return `<div class="game-block fade-up" id="b-${block.id}">
      <div class="game-header">
        <span class="game-icon">\u{1F3AE}</span>
        <h4>${block.title}</h4>
        <span class="game-timer" id="gt-${block.id}">1:00</span>
      </div>
      <div class="game-area" id="ga-${block.id}"></div>
      <button class="game-start-btn" onclick="app.startGame('${block.id}','${gameFile}')">Play!</button>
    </div>`;
  }

  async startGame(blockId, gameFile) {
    const area = document.getElementById(`ga-${blockId}`);
    const timerEl = document.getElementById(`gt-${blockId}`);
    const startBtn = area?.parentElement?.querySelector('.game-start-btn');
    if (!area) return;
    if (startBtn) startBtn.style.display = 'none';

    // Load game data from JSON
    let game;
    try {
      const res = await fetch(`games/${gameFile}.json`);
      game = await res.json();
    } catch (e) {
      area.innerHTML = '<div class="game-over">Could not load game.</div>';
      return;
    }

    // 60s timer
    let seconds = 60;
    if (this._activeGameTimer) clearInterval(this._activeGameTimer);
    this._activeGameTimer = setInterval(() => {
      seconds--;
      if (timerEl) timerEl.textContent = `0:${seconds.toString().padStart(2, '0')}`;
      if (seconds <= 10 && timerEl) timerEl.style.color = '#EF4444';
      if (seconds <= 0) {
        clearInterval(this._activeGameTimer);
        this._gameEnd(area, 'Time\'s up! Nice try.');
      }
    }, 1000);

    // Launch by type
    if (game.type === 'sort') this._gameSort(area, game);
    else if (game.type === 'match') this._gameMatch(area, game);
    else if (game.type === 'pop') this._gamePop(area, game);
    else if (game.type === 'order') this._gameOrder(area, game);
    else this._gameSort(area, game);
  }

  _gameEnd(area, msg) {
    if (this._activeGameTimer) clearInterval(this._activeGameTimer);
    area.innerHTML = `<div class="game-over">${msg} <b>+5 XP</b></div>`;
    this.user.addXP(5); this.user.save();
    this.showXPToast('+5 XP \u{1F3AE}', 'xp');
    this._updateMissionBar();
    setTimeout(() => {
      const block = area.closest('.game-block');
      if (block) { block.style.opacity = '.5'; block.style.pointerEvents = 'none'; }
    }, 2500);
  }

  // Sort game: classify items into two buckets
  _gameSort(area, game) {
    const items = [...game.items].sort(() => Math.random() - 0.5);
    let score = 0, idx = 0;
    const show = () => {
      if (idx >= items.length) { this._gameEnd(area, `Done! ${score}/${items.length} correct.`); return; }
      const item = items[idx++];
      area.innerHTML = `<div class="game-signal-card">${item.text}</div>
        <div class="game-buckets">${game.buckets.map((b, bi) =>
          `<button class="game-bucket ${bi === 0 ? 'strong' : 'weak'}" data-ans="${bi}">${b}</button>`
        ).join('')}</div>
        <div class="game-score">${score}/${idx - 1} correct</div>`;
      area.querySelectorAll('.game-bucket').forEach(btn => {
        btn.onclick = () => {
          area.querySelectorAll('.game-bucket').forEach(b => b.disabled = true);
          if (parseInt(btn.dataset.ans) === item.answer) { btn.classList.add('game-correct'); score++; }
          else btn.classList.add('game-wrong');
          setTimeout(show, 500);
        };
      });
    };
    show();
  }

  // Match game: find taste twin in a rating grid
  _gameMatch(area, game) {
    const items = game.items;
    const you = items.map(() => Math.ceil(Math.random() * 5));
    const users = game.users.map(name => ({
      name,
      ratings: items.map(() => Math.ceil(Math.random() * 5))
    }));
    const twin = Math.floor(Math.random() * users.length);
    users[twin].ratings = items.map((_, j) => Math.max(1, Math.min(5, you[j] + (Math.random() < 0.65 ? 0 : (Math.random() < 0.5 ? -1 : 1)))));

    let table = `<table class="game-table"><tr><th></th>${items.map(m => `<th>${m}</th>`).join('')}</tr>`;
    table += `<tr class="game-you"><td><b>You</b></td>${you.map(r => `<td>${'\u2B50'.repeat(r)}</td>`).join('')}</tr>`;
    users.forEach(u => { table += `<tr><td class="game-pick">${u.name}</td>${u.ratings.map(r => `<td>${'\u2B50'.repeat(r)}</td>`).join('')}</tr>`; });
    table += '</table>';
    area.innerHTML = `<div class="game-prompt">${game.instruction}</div>${table}`;
    area.querySelectorAll('.game-pick').forEach((td, i) => {
      td.onclick = () => {
        if (i === twin) { this._gameEnd(area, `Correct! ${users[twin].name} is your taste twin! That's collaborative filtering.`); }
        else { td.style.color = '#EF4444'; td.style.textDecoration = 'line-through'; }
      };
    });
  }

  // Pop game: click items to collect/escape
  _gamePop(area, game) {
    const cats = [...game.categories];
    const target = cats[Math.floor(Math.random() * cats.length)];
    const popped = new Set();
    const render = () => {
      area.innerHTML = `<div class="game-prompt">${game.instruction} Your bubble: <b>${target}</b> (${popped.size}/${cats.length - 1})</div>
        <div class="game-bubble-grid">${cats.sort(() => Math.random() - 0.5).map(c => {
          const done = popped.has(c);
          return `<button class="game-bubble-item ${c === target ? 'in-bubble' : ''} ${done ? 'popped' : ''}" ${done ? 'disabled' : ''}>${c}</button>`;
        }).join('')}</div>`;
      area.querySelectorAll('.game-bubble-item:not([disabled])').forEach(btn => {
        btn.onclick = () => {
          if (btn.textContent.trim() === target) { btn.classList.add('game-wrong'); }
          else { popped.add(btn.textContent.trim()); if (popped.size >= cats.length - 1) this._gameEnd(area, 'Bubble popped! Diversity wins!'); else render(); }
        };
      });
    };
    render();
  }

  // Order game: put steps in correct sequence
  _gameOrder(area, game) {
    const steps = game.steps;
    const shuffled = steps.map((text, i) => ({ text, order: i })).sort(() => Math.random() - 0.5);
    const selected = [];
    const render = () => {
      const remaining = shuffled.filter(s => !selected.includes(s));
      area.innerHTML = `<div class="game-prompt">${game.instruction}</div>
        <div class="game-pipeline-selected">${selected.map((s, i) => `<div class="game-pipe-step done">${i + 1}. ${s.text}</div>`).join('')}</div>
        <div class="game-pipeline-options">${remaining.map(s =>
          `<button class="game-pipe-btn">${s.text}</button>`
        ).join('')}</div>`;
      area.querySelectorAll('.game-pipe-btn').forEach(btn => {
        btn.onclick = () => {
          const step = remaining.find(s => s.text === btn.textContent);
          if (step && step.order === selected.length) {
            selected.push(step);
            if (selected.length >= steps.length) this._gameEnd(area, 'Perfect order! You nailed the pipeline!');
            else render();
          } else { btn.classList.add('game-wrong'); setTimeout(() => btn.classList.remove('game-wrong'), 400); }
        };
      });
    };
    render();
  }

  renderQuestion(block) {
    // Structured options in frontmatter
    if (block.options && Array.isArray(block.options)) {
      const opts = block.options.map(o => `<button class="q-opt" onclick="app.answerQ(this,'${o.voice || 'universal'}','${block.id}')"><span class="q-letter">${o.letter}</span><span>${o.text}</span></button>`).join('');
      return `<div class="q-block fade-up"><h4>${block.title}</h4><div class="q-desc">${block.description || ''}</div><div class="q-opts">${opts}</div></div>`;
    }
    // Body-based question: parse A/B/C/D options from markdown body
    if (block.body) {
      const bodyHtml = renderMarkdown(block.body);
      // Extract lettered options and create clickable buttons
      const optRegex = /\*\*([A-D])[):.]*\*{0,2}\s*"([^"]+)"/g;
      const voiceMap = { A: 'explorer', B: 'creator', C: 'thinker', D: 'universal' };
      const opts = [];
      let m;
      while ((m = optRegex.exec(block.body)) !== null) {
        opts.push({ letter: m[1], text: m[2].trim().substring(0, 80), voice: voiceMap[m[1]] || 'universal' });
      }
      if (opts.length >= 2) {
        const optsHtml = opts.map(o => `<button class="q-opt" onclick="app.answerQ(this,'${o.voice}','${block.id}')"><span class="q-letter">${o.letter}</span><span>${o.text}</span></button>`).join('');
        return `<div class="q-block fade-up" id="b-${block.id}"><div class="block-header"><h4>${block.title}</h4></div><div class="spine-body">${bodyHtml}</div><div class="q-opts">${optsHtml}</div></div>`;
      }
      // No parseable options — just render as article
      return `<article class="block-article fade-up" id="b-${block.id}"><div class="block-header"><h3>${block.title}</h3></div><div class="spine-body">${bodyHtml}</div></article>`;
    }
    return '';
  }

  // Inline "read next" below each article — shown after block is read
  renderReadNext(blockId, ch) {
    const spines = ch.blocks.filter(b => b.type === 'spine');
    const currentIdx = spines.findIndex(b => b.id === blockId);
    const nextInChapter = spines[currentIdx + 1];

    // Find a personalized recommendation (different from sequential next)
    let recBlock = null;
    const unreadOther = this.allBlocks.filter(b =>
      b._chapter !== ch.id && b.meta.type === 'spine' && !this.user.readBlocks.has(b.meta.id) && b.meta.id !== nextInChapter?.id
    );
    // Prefer voice-matching blocks
    const voice = this.user.preferredVoice;
    if (voice && voice !== 'universal') {
      recBlock = unreadOther.find(b => b.meta.voice === voice) || unreadOther[0];
    } else {
      recBlock = unreadOther.sort(() => Math.random() - 0.5)[0];
    }

    let items = '';
    if (nextInChapter) {
      items += `<div class="rn-item" onclick="app.previewBlock('${nextInChapter.id}')"><span class="rn-label">Next</span><span class="rn-title">${nextInChapter.title}</span><span class="rn-time">${nextInChapter.readingTime || 3}m</span></div>`;
    }
    if (recBlock) {
      items += `<div class="rn-item rn-rec" onclick="app.previewBlock('${recBlock.meta.id}')"><span class="rn-label">\u2728 Recommended</span><span class="rn-title">${recBlock.meta.title}</span><span class="rn-time">Ch${recBlock.meta._chapterNum}</span></div>`;
    }
    if (!items) return '';

    // "More like this" — text similarity, dedup with next/recommended
    const excludeIds = new Set([blockId]);
    if (nextInChapter) excludeIds.add(nextInChapter.id);
    if (recBlock) excludeIds.add(recBlock.meta.id);
    const similar = this._findSimilarBlocks(blockId, 5).filter(s => !excludeIds.has(s.id)).slice(0, 3);
    if (similar.length) {
      items += '<div class="rn-similar"><div class="rn-similar-label">More like this</div>';
      similar.forEach(s => {
        const isRead = this.user.readBlocks.has(s.id);
        items += `<div class="rn-similar-item ${isRead ? 'rn-read' : ''}" onclick="app.previewBlock('${s.id}')">
          <span class="rn-similar-title">${s.title}</span>
          <span class="rn-similar-ch">Ch${s.chNum}</span>
        </div>`;
      });
      items += '</div>';
    }

    // For shared-link visitors: CTA to explore the full book
    if (this._sharedBlockId === blockId) {
      items += `<div class="rn-cta">
        <div class="rn-cta-text">Enjoyed this? There are ${this.allBlocks.filter(b => b.meta.type === 'spine').length} more sections to explore!</div>
        <button class="rn-cta-btn" onclick="app.showWelcome()">Explore the full book &rarr;</button>
      </div>`;
    }

    return `<div class="read-next" id="rn-${blockId}">${items}</div>`;
  }

  // Preview panel — shows teaser before navigating away
  shareBlock(blockId) {
    const block = this.findBlock(blockId);
    if (!block) return;
    const url = window.location.origin + window.location.pathname + '#' + blockId;
    const title = block.meta.title;
    const text = block.meta.teaser || 'Check out this section from "How Recommendations Work"';

    // Try native share first (mobile)
    if (navigator.share) {
      navigator.share({ title, text, url }).catch(() => {});
    } else {
      // Fallback: copy to clipboard
      navigator.clipboard.writeText(url).then(() => {
        this.showXPToast('Link copied!', 'info');
      }).catch(() => {
        // Double fallback
        prompt('Share this link:', url);
      });
    }
    this.rc.logEvent('share', { blockId, mode: 'share' });
  }

  shareMission(missionId) {
    const m = this.getMissions().find(x => x.id === missionId);
    if (!m) return;
    const url = window.location.origin + window.location.pathname + '#mission-' + missionId;
    const title = m.title;
    const text = m.story.substring(0, 100);

    if (navigator.share) {
      navigator.share({ title, text, url }).catch(() => {});
    } else {
      navigator.clipboard.writeText(url).then(() => {
        this.showXPToast('Mission link copied!', 'info');
      }).catch(() => { prompt('Share this link:', url); });
    }
    this.rc.logEvent('share', { missionId, mode: 'share_mission' });
  }

  previewBlock(blockId) {
    const block = this.findBlock(blockId);
    if (!block) { this.openBlock(blockId); return; }
    const m = block.meta;
    const teaser = m.teaser || (block.body || '').substring(0, 200).replace(/[#*_\[\]]/g, '').trim();

    // Remove existing preview
    document.getElementById('previewPanel')?.remove();

    const panel = document.createElement('div');
    panel.id = 'previewPanel';
    panel.className = 'preview-panel';
    panel.innerHTML = `
      <div class="preview-content">
        <div class="preview-header">
          <span class="preview-ch">Ch${m._chapterNum}</span>
          <span class="preview-title">${m.title}</span>
          <button class="preview-close" onclick="document.getElementById('previewPanel').remove()">&times;</button>
        </div>
        <div class="preview-teaser">${this.escHtml(teaser)}${teaser.length >= 200 ? '...' : ''}</div>
        <div class="preview-actions">
          <button class="preview-go" onclick="document.getElementById('previewPanel').remove();app.openBlock('${blockId}')">Read this &rarr;</button>
          <button class="preview-dismiss" onclick="document.getElementById('previewPanel').remove()">Stay here</button>
        </div>
      </div>
    `;
    document.body.appendChild(panel);
  }

  _updateInlineReadNext(blockId, ch) {
    const el = document.getElementById(`rn-${blockId}`);
    if (el) { el.classList.add('rn-visible'); return; }
    // Insert after the block article
    const article = document.getElementById(`b-${blockId}`);
    if (!article) return;
    const html = this.renderReadNext(blockId, ch);
    if (html) article.insertAdjacentHTML('afterend', html);
    // Show with animation
    setTimeout(() => document.getElementById(`rn-${blockId}`)?.classList.add('rn-visible'), 50);
  }



  showBlockRecall(blockId) {
    // Toggle recall card inline below this block
    const existing = document.getElementById(`block-recall-${blockId}`);
    if (existing) { existing.remove(); return; }
    const block = this.findBlock(blockId);
    if (!block) return;
    const quiz = this._getRecallQuestion(block);
    if (!quiz) return;
    const article = document.getElementById(`b-${blockId}`);
    if (!article) return;
    const html = `<div class="inline-recall fade-up" id="block-recall-${blockId}">
      <div class="ir-header"><span class="ir-icon">\u{1F9E0}</span> Test your memory</div>
      <div class="ir-question">${quiz.q}</div>
      <div class="ir-answer" id="br-a-${blockId}" style="display:none">
        <div class="ir-answer-text">${quiz.a}</div>
        ${this.user.recall[blockId] ? `<div class="recall-buttons">
          <button class="recall-btn recall-forgot" onclick="app.scoreRecall('${blockId}',0);document.getElementById('block-recall-${blockId}').remove()">Forgot</button>
          <button class="recall-btn recall-hard" onclick="app.scoreRecall('${blockId}',1);document.getElementById('block-recall-${blockId}').remove()">Hard</button>
          <button class="recall-btn recall-good" onclick="app.scoreRecall('${blockId}',2);document.getElementById('block-recall-${blockId}').remove()">Good</button>
          <button class="recall-btn recall-easy" onclick="app.scoreRecall('${blockId}',3);document.getElementById('block-recall-${blockId}').remove()">Easy!</button>
        </div>` : `<button class="recall-reveal" onclick="document.getElementById('block-recall-${blockId}').remove()">Got it!</button>`}
      </div>
      <button class="recall-reveal" onclick="document.getElementById('br-a-${blockId}').style.display='block';this.style.display='none'">Show answer</button>
    </div>`;
    article.insertAdjacentHTML('afterend', html);
    document.getElementById(`block-recall-${blockId}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  _insertInlineRecall(justReadId) {
    if (!this._f('spaceRepetition')) return;
    // Find a due or almost-due recall for a DIFFERENT block
    const now = Date.now();
    const soonThreshold = 30 * 60 * 1000;
    const due = Object.entries(this.user.recall)
      .filter(([id, c]) => id !== justReadId && c.nextReview <= now + soonThreshold)
      .sort((a, b) => a[1].nextReview - b[1].nextReview)
      .map(([blockId, card]) => ({ blockId, ...card }));
    if (!due.length) return;
    const r = due[0];
    const block = this.findBlock(r.blockId);
    if (!block) return;
    const quiz = this._getRecallQuestion(block);
    if (!quiz) return;
    // Don't insert if one already exists for this block
    if (document.getElementById(`inline-recall-${r.blockId}`)) return;
    const article = document.getElementById(`b-${justReadId}`);
    if (!article) return;
    // Find the read-next div to insert after it, or after the article
    const readNext = document.getElementById(`rn-${justReadId}`);
    const insertAfter = readNext || article;
    const html = `<div class="inline-recall fade-up" id="inline-recall-${r.blockId}">
      <div class="ir-header"><span class="ir-icon">\u{1F9E0}</span> Do you remember?</div>
      <div class="ir-question">${quiz.q}</div>
      <div class="ir-answer" id="ir-a-${r.blockId}" style="display:none">
        <div class="ir-answer-text">${quiz.a}</div>
        <div class="ir-from">From: ${block.meta.title}</div>
        <div class="recall-buttons">
          <button class="recall-btn recall-forgot" onclick="app.scoreRecall('${r.blockId}',0);document.getElementById('inline-recall-${r.blockId}').remove()">Forgot</button>
          <button class="recall-btn recall-hard" onclick="app.scoreRecall('${r.blockId}',1);document.getElementById('inline-recall-${r.blockId}').remove()">Hard</button>
          <button class="recall-btn recall-good" onclick="app.scoreRecall('${r.blockId}',2);document.getElementById('inline-recall-${r.blockId}').remove()">Good</button>
          <button class="recall-btn recall-easy" onclick="app.scoreRecall('${r.blockId}',3);document.getElementById('inline-recall-${r.blockId}').remove()">Easy!</button>
        </div>
      </div>
      <button class="recall-reveal" onclick="document.getElementById('ir-a-${r.blockId}').style.display='block';this.style.display='none'">Hmm... Show answer!</button>
    </div>`;
    insertAfter.insertAdjacentHTML('afterend', html);
  }

  _recallCardHtml(r) {
    const block = this.findBlock(r.blockId);
    if (!block) return '';
    const quiz = this._getRecallQuestion(block);
    if (!quiz) return '';
    return `<div class="card recall-card" style="border-top: 3px solid var(--warn); flex: 0 0 280px">
      <div class="card-chapter" style="color:var(--warn);font-weight:700">Do you remember?</div>
      <div class="card-title">${quiz.q}</div>
      <div class="recall-answer" id="recall-a-${r.blockId}" style="display:none">
        <div class="recall-answer-text">${quiz.a}</div>
        <div class="recall-hint" style="font-size:.7rem;color:var(--text-3);margin:.3em 0">From: ${block.meta.title}</div>
        <div class="recall-buttons">
          <button class="recall-btn recall-forgot" onclick="app.scoreRecall('${r.blockId}',0)">Forgot</button>
          <button class="recall-btn recall-hard" onclick="app.scoreRecall('${r.blockId}',1)">Hard</button>
          <button class="recall-btn recall-good" onclick="app.scoreRecall('${r.blockId}',2)">Good</button>
          <button class="recall-btn recall-easy" onclick="app.scoreRecall('${r.blockId}',3)">Easy!</button>
        </div>
      </div>
      <button class="recall-reveal" id="recall-r-${r.blockId}" onclick="document.getElementById('recall-a-${r.blockId}').style.display='block';this.style.display='none'">Show answer</button>
    </div>`;
  }

  _generateQuiz(block) {
    const body = (block.body || '').toLowerCase();
    const quizzes = [];

    // --- Kid-friendly quizzes matched to content keywords ---

    // Ch1: What are recommendations
    if (body.includes('youtube') && body.includes('recommend')) quizzes.push({ q: 'How does YouTube pick videos for your homepage?', a: 'It looks at what you watched before and finds patterns — if you liked cat videos, it guesses you might like more!' });
    if (body.includes('pattern')) quizzes.push({ q: 'What are recommender systems really good at finding?', a: 'Patterns! They notice things like "people who liked X also liked Y" — like a super-powered detective.' });
    if (body.includes('discover') && body.includes('find')) quizzes.push({ q: 'Can you name the 3 jobs of a recommender system?', a: '1) Help you DISCOVER new things, 2) Help you FIND stuff faster, 3) Keep you INTERESTED so you come back!' });
    if (body.includes('peppa pig') || body.includes('wrong') || body.includes('hilarious')) quizzes.push({ q: 'Why do recommendations sometimes go totally wrong?', a: 'Because the system only sees clicks, not reasons. If your sibling watches cartoons on your account, it thinks YOU like cartoons!' });

    // Ch2: How they learn
    if (body.includes('footprint') || body.includes('digital')) quizzes.push({ q: 'What are "digital footprints"?', a: 'Every click, watch, skip, and search you make — like footprints in sand that tell the system about your taste!' });
    if (body.includes('skip') && body.includes('watch')) quizzes.push({ q: 'Which tells the system MORE about you: watching a video to the end, or skipping after 3 seconds?', a: 'Both! Watching to the end says "loved it!" Skipping says "not for me." The system learns from everything you do.' });
    if (body.includes('cold start') || body.includes('new account')) quizzes.push({ q: 'What happens when you create a brand new account?', a: 'The "cold start" problem! The system has zero clues about you, so recommendations are pretty random at first. But it learns FAST!' });
    if (body.includes('privacy') || body.includes('your data')) quizzes.push({ q: 'True or false: You have NO control over what recommendations show you.', a: 'FALSE! You can clear history, say "not interested," use separate profiles, and even go incognito. Your data = your choice!' });

    // Ch3: Different methods
    if (body.includes('collaborative') || body.includes('similar taste')) quizzes.push({ q: 'You and your friend both love the same 5 movies. Your friend finds a new one and loves it. Will you probably like it too?', a: 'Probably yes! That is exactly how collaborative filtering works — finding people with matching taste and sharing their discoveries.' });
    if (body.includes('content-based') || body.includes('look at the thing')) quizzes.push({ q: 'What is the difference between asking your friends vs. looking at the thing itself?', a: 'Asking friends (collaborative filtering) = find people with similar taste. Looking at the thing (content-based) = find items with similar features. Both work, but differently!' });
    if (body.includes('popular') || body.includes('trending')) quizzes.push({ q: 'Why is "just show what is popular" not always the best strategy?', a: 'Because it does not know YOU at all! Popular stuff is popular for a reason, but you might have unique tastes that trending lists miss completely.' });
    if (body.includes('pipeline') || body.includes('find') && body.includes('rank')) quizzes.push({ q: 'What are the 3 steps in a recommendation pipeline?', a: '1) FIND — gather hundreds of candidates, 2) RANK — score each one for you personally, 3) CHECK — add variety and remove stuff you already saw!' });
    if (body.includes('netflix') && body.includes('prize')) quizzes.push({ q: 'Netflix offered $1 million for better recommendations. What happened?', a: 'Over 40,000 teams competed! The winners made it 10% better by combining 100+ methods. But it was too complicated to actually use. Sometimes simpler is better!' });

    // Ch4: Making them better
    if (body.includes('filter bubble') || body.includes('bubble')) quizzes.push({ q: 'What is a "filter bubble" and why should you care?', a: 'When recommendations only show you things you already like, you get stuck in a bubble. You never discover new interests! It is like only eating pizza forever.' });
    if (body.includes('echo chamber')) quizzes.push({ q: 'How is an echo chamber different from a filter bubble?', a: 'A filter bubble limits what you discover. An echo chamber is worse — it makes you think EVERYONE agrees with you because you only hear your own opinions reflected back!' });
    if (body.includes('fair') || body.includes('new creator')) quizzes.push({ q: 'Why might a recommendation system be unfair to new creators?', a: 'Because popular creators get recommended more → get more views → become even more popular. New creators barely get seen. Good systems give new content a chance!' });
    if (body.includes('a/b test') || body.includes('experiment')) quizzes.push({ q: 'What is an A/B test?', a: 'A science experiment with real users! Half see version A, half see version B. Compare the results to find out which is actually better. Companies do this all the time!' });

    // Ch5: Build your own
    if (body.includes('survey') || body.includes('rate') && body.includes('movie')) quizzes.push({ q: 'What is the first step to building your own recommendation system?', a: 'Collect data! Survey your friends — ask them to rate movies 1-5 stars. That grid of ratings is exactly what Netflix and Spotify use!' });
    if (body.includes('similar') && body.includes('rating')) quizzes.push({ q: 'How do you find people with similar taste using a rating grid?', a: 'Look for people who gave the SAME movies similar scores. If you both rated Frozen 5 stars and Moana 4 stars, you probably have matching taste!' });
    if (body.includes('predict') || body.includes('empty cell')) quizzes.push({ q: 'How do you predict if someone will like a movie they have not seen?', a: 'Find 2-3 people with similar taste who DID see it. Average their ratings. If they gave it 4+ stars, recommend it!' });
    if (body.includes('improve') || body.includes('more data')) quizzes.push({ q: 'Name 2 ways to make your recommendation system better.', a: 'Get MORE data (survey more people), and do not just look at ratings — also consider what TYPE of movie it is (animation, action, comedy)!' });

    // Fallback: generate from title
    if (quizzes.length === 0) {
    // Ch6: Ethics
    if (body.includes('rabbit hole') || body.includes('who decides')) quizzes.push({ q: 'Who decides what appears on your YouTube homepage — you, YouTube, or the algorithm?', a: 'The algorithm decides! It was built by YouTube engineers who told it to maximize watch time. You influence it with clicks, but the final call is the algorithm\'s.' });
    if (body.includes('autoplay') || body.includes('infinite scroll') || body.includes('addictive')) quizzes.push({ q: 'Why is there no natural stopping point on TikTok or YouTube?', a: 'By design! Infinite scroll and autoplay mean there\'s always another video ready. It\'s like a bag of chips that never runs out. Knowing this is the first step to taking control.' });
    if (body.includes('dopamine') || body.includes('one more')) quizzes.push({ q: 'What brain chemical makes you want to watch "just one more video"?', a: 'Dopamine! It\'s released when you see something surprising or rewarding. The uncertainty of "will the next video be good?" creates a dopamine loop. Recognizing it is a superpower!' });
    if (body.includes('privacy') || body.includes('data') && body.includes('know')) quizzes.push({ q: 'Can you check what data YouTube has collected about you?', a: 'Yes! Go to myactivity.google.com — you can see every video you\'ve ever watched. You can also delete it or set it to auto-delete.' });
    if (body.includes('future') || body.includes('your generation')) quizzes.push({ q: 'Why does YOUR generation understand algorithms better than most adults?', a: 'Because you grew up WITH them! You notice when recommendations are weird, you know how to game the algorithm, and you feel the pull of infinite scroll. That experience is real knowledge.' });
    if (body.includes('eu') || body.includes('law') || body.includes('digital services')) quizzes.push({ q: 'What new right did the EU give people regarding algorithms?', a: 'The right to opt OUT of algorithmic recommendations! The Digital Services Act also stops platforms from using kids\' personal data for recommendations.' });

    // Fallback
    if (quizzes.length === 0)
      quizzes.push({ q: 'Can you explain "' + (block.title || 'this topic') + '" to a friend in one sentence?', a: 'Try it! If you can explain it simply, you really understand it. If not, read the section again — it will make more sense the second time!' });
    }

    const quiz = quizzes[Math.floor(Math.random() * quizzes.length)];
    return `<h4>&#129504; Quick Quiz!</h4>
      <div class="ctx-quiz">
        <div class="ctx-quiz-q">${quiz.q}</div>
        <button class="ctx-quiz-reveal" onclick="this.nextElementSibling.style.display='block';this.style.display='none'">Hmm, let me think... &#129300; Show answer!</button>
        <div class="ctx-quiz-a" style="display:none">${quiz.a}</div>
      </div>`;
  }

  // --- Spaced repetition recall ---
  _getRecallQuestion(block) {
    const id = block.meta?.id || block.id;
    const title = block.meta?.title || '';
    const body = (block.body || '').toLowerCase();
    const meta = block.meta || {};

    // 1. Prefer frontmatter Q&A (editable by content creators)
    if (meta.recallQ && meta.recallA) return { q: meta.recallQ, a: meta.recallA };

    // 2. Fallback: hardcoded questions (kept for backwards compat)
    const QUESTIONS = {
      // ── Ch1: What Are Recommendations? ──
      'ch1-noticed': { q: 'How do apps like YouTube seem to "know" what you want?', a: 'They track your clicks, watches, and skips to build a picture of your taste — then use algorithms to find similar content.' },
      'ch1-everywhere': { q: 'Name 4 apps that use recommendation algorithms.', a: 'YouTube, TikTok, Spotify, Netflix, Amazon, Instagram, App Store — almost every app you use daily.' },
      'ch1-not-magic': { q: 'Recommendations feel like magic — what are they really based on?', a: 'Patterns! Watch → find patterns → predict. Like a detective finding clues in your clicks.' },
      'ch1-wrong-sidebar': { q: 'Why do recommendations sometimes go hilariously wrong?', a: 'The system only sees clicks, not reasons. If your sibling watches cartoons on your account, it thinks YOU like cartoons!' },
      'ch1-patterns-d-think': { q: 'Why is finding patterns a "superpower" for algorithms?', a: 'Machines can spot patterns across millions of people simultaneously — connections no human could ever find manually.' },
      'ch1-three-jobs': { q: 'What are the 3 jobs of a recommender system?', a: 'DISCOVER new things, FIND things faster in huge catalogs, and ENGAGE — keep you interested.' },
      'ch1-wyr': { q: 'What is the main trade-off in recommendations?', a: 'Better recommendations need more data, but more data means companies know more about you. Privacy vs. personalization.' },
      'ch1-ws-match': { q: 'Name 3 different recommendation models.', a: 'Friend-based, follow-based, interest-based, algorithm-based, and group-based. Most apps use hybrids.' },
      // ── Ch2: How They Learn About You ──
      'ch2-footprints': { q: 'What are digital footprints?', a: 'Every click, watch, skip, and search — invisible tracks that teach the system about your taste.' },
      'ch2-track-d-exp': { q: 'Which signal is stronger: clicking a video or watching it to the end?', a: 'Watching to the end is MUCH stronger. The system tracks watch time, not just clicks.' },
      'ch2-guess-signal': { q: 'What is the strongest signal you can send to an algorithm?', a: 'Sharing something! It takes real effort, which tells the system you really care about that content.' },
      'ch2-clues': { q: 'Name the 3 types of clues recommenders use.', a: 'Item clues (what it IS), person clues (who YOU are), action clues (what you DO).' },
      'ch2-incognito-sidebar': { q: 'What is the "cold start" problem?', a: 'When you create a new account, the system has zero info — it shows popular stuff until it learns who you are.' },
      'ch2-myth': { q: 'True or false: your phone listens to your conversations for ads.', a: 'False! Algorithms predict so well from your clicks that it FEELS like they heard you — but they didn\'t.' },
      'ch2-privacy': { q: 'Name 3 tools you have to control your data.', a: '"Not Interested" button, clear history, separate profiles, incognito mode, and app settings.' },
      'ch2-privacy-d-create': { q: 'How fast does an algorithm start personalizing for you?', a: 'Just 5-10 videos! Watch a few cooking videos and your feed fills with cooking in minutes.' },
      'ch2-ws-detective': { q: 'Can you train the algorithm on purpose?', a: 'Yes! Search for topics you want, like content deliberately, use "Not Interested" on what you don\'t want.' },
      // ── Ch3: Different Ways to Recommend ──
      'ch3-friends': { q: 'How does collaborative filtering work?', a: 'Find people with similar taste → recommend what THEY liked that you haven\'t tried yet.' },
      'ch3-cf-d-exp': { q: 'What are "taste twins" in collaborative filtering?', a: 'People who liked the same things as you. If they also liked something new, you probably will too!' },
      'ch3-cf-d-create': { q: 'Can you build collaborative filtering without a computer?', a: 'Yes! Survey friends, create a rating grid on paper, find who matches you best, check what they liked.' },
      'ch3-netflix-sidebar': { q: 'What lesson did the Netflix Prize teach about algorithms?', a: 'Better accuracy doesn\'t always win — speed and simplicity matter more than perfection in real systems.' },
      'ch3-content': { q: 'How does content-based filtering differ from collaborative?', a: 'Content-based looks at item FEATURES (genre, tags). Collaborative looks at USER BEHAVIOR (who liked what).' },
      'ch3-compare-d-think': { q: 'When is content-based better than collaborative filtering?', a: 'For new items with no ratings yet, and for niche interests. Collaborative is better for surprising discoveries.' },
      'ch3-spot-method': { q: '"Because you watched X" uses which method?', a: 'Content-based filtering! It finds items similar to X. "Fans also listen to" is collaborative filtering.' },
      'ch3-bandits': { q: 'What is the explore-exploit dilemma?', a: 'Should the system show safe picks you\'ll like (exploit) or try new things you might discover (explore)? Both matter.' },
      'ch3-deep-similarity': { q: 'What are "embeddings" in recommendation systems?', a: 'Items turned into lists of numbers (vectors). Close vectors = similar items. Neural networks learn these patterns.' },
      'ch3-popular': { q: 'What is the biggest weakness of popularity-based recommendations?', a: 'No personalization — everyone sees the same thing. It can\'t account for YOUR unique taste.' },
      'ch3-popular-sidebar': { q: 'What is the "rich-get-richer" problem?', a: 'Popular content gets more visibility → more views → stays popular. New creators get buried forever.' },
      'ch3-pipeline': { q: 'What are the 3 stages of a recommendation pipeline?', a: 'FIND candidates (fast + rough), RANK them (precise scoring), CHECK for diversity.' },
      'ch3-pipeline-d-exp': { q: 'How does YouTube find 20 videos from 800 million in 0.2 seconds?', a: 'Staged pipeline! Quick rough filters narrow 800M to 500 candidates, then careful ranking picks the best 20.' },
      'ch3-speed': { q: 'How long would it take a human to do what YouTube does in 1 second?', a: '25 YEARS! That\'s why we need algorithms — the scale is impossibly large for humans.' },
      'ch3-search-recs': { q: 'Are search results the same for everyone?', a: 'No! Search is increasingly personalized — what you see depends on your history, location, and past behavior.' },
      // ── Ch4: Making Recommendations Better ──
      'ch4-bubbles': { q: 'What is a filter bubble?', a: 'When the algorithm only shows you things you already like — you never discover anything new. The bubble is invisible.' },
      'ch4-echo-d-think': { q: 'How is an echo chamber worse than a filter bubble?', a: 'Echo chambers make you think EVERYONE agrees with you — different people see different realities about the same topic.' },
      'ch4-experiment': { q: 'How can you break out of a filter bubble?', a: 'Deliberately explore new content! Watch 3 videos on a new topic and your feed will start to change.' },
      'ch4-fairness': { q: 'How can algorithms be unfair to new creators?', a: 'Popular → more recommended → more popular (repeat). New creators never get seen. Good systems give everyone a fair start.' },
      'ch4-youtube-sidebar': { q: 'What percentage of YouTube watch time comes from recommendations?', a: '70%! That means algorithms — not you searching — drive most of what people watch.' },
      'ch4-unfair-game': { q: 'How can platforms make recommendations fairer?', a: 'Random sampling, guaranteed visibility for new content, small-audience testing before scaling.' },
      'ch4-objectives': { q: 'What is the algorithm actually trying to do?', a: 'It depends! Subscription services optimize for YOUR happiness. Free/ad services optimize for ADVERTISER revenue.' },
      'ch4-explainability': { q: 'Why can\'t platforms fully explain their recommendations?', a: 'Neural networks use hundreds of signals — even engineers can\'t trace exactly why one item was chosen over another.' },
      'ch4-testing': { q: 'What is an A/B test?', a: 'Show version A to half the users, version B to the other half, compare real behavior. Data decides, not guessing.' },
      'ch4-ab-d-exp': { q: 'Do personalized recommendations actually work better than "just show popular"?', a: 'Yes! Tests show 37% more songs played, 4x more artist discovery, and higher engagement with personalization.' },
      // ── Ch5: Build Your Own! ──
      'ch5-start': { q: 'What are the 4 steps to build a recommendation system?', a: 'Collect data → find similar users → make predictions → test and improve.' },
      'ch5-collect': { q: 'What is a rating matrix?', a: 'Users as rows, items as columns, ratings in cells. Most cells are empty — that\'s what you predict.' },
      'ch5-spread-d-create': { q: 'Why can a spreadsheet help you build recommendations?', a: 'Color-coded ratings reveal taste patterns visually — you can see who matches before doing any math.' },
      'ch5-similar': { q: 'How do you find "taste neighbors"?', a: 'Compare ratings on shared items — lower average difference = more similar taste.' },
      'ch5-math-d-think': { q: 'What does cosine similarity measure?', a: 'The angle between two preference vectors — so someone who rates everything low but in the same PATTERN as you is still similar.' },
      'ch5-real-numbers': { q: 'How many possible user-item combinations does Netflix have?', a: '3.4 TRILLION! And most cells are empty. Finding patterns in this sparse data is the core challenge.' },
      'ch5-recommend': { q: 'How do you predict a rating for an unseen item?', a: 'Find 2-3 most similar users who rated it → average their ratings. Above 4 stars = recommend it.' },
      'ch5-code-d-create': { q: 'How many lines of Python does it take to build basic collaborative filtering?', a: 'About 20! Data loading, similarity calculation, and prediction — the same logic Netflix uses, just smaller scale.' },
      'ch5-debug': { q: 'Even Netflix\'s algorithm is wrong how often?', a: '20-30% of the time! Perfection isn\'t the goal — being right MOST of the time is what matters.' },
      'ch5-improve': { q: 'What is the single biggest improvement for a recommendation system?', a: 'More data! More users and more ratings create more connections, which means better matches and predictions.' },
      'ch5-career-sidebar': { q: 'What skills does a recommendation engineer need?', a: 'Math (statistics, linear algebra), programming (Python), creativity, and curiosity about user behavior.' },
      'ch5-get-recommended': { q: 'What matters more to YouTube: clicks or watch time?', a: 'Watch time! A video 100 people watch fully beats 1,000 clicks that leave immediately.' },
      'ch5-seo-algorithms': { q: 'Why doesn\'t "ranking #1 on Google" exist anymore?', a: 'Results are personalized — your content can be #1 for your audience and invisible to everyone else.' },
      // ── Ch6: Ethics and You ──
      'ch6-who-decides': { q: 'Who decides what you see when you open TikTok?', a: 'The algorithm — not you, not your parents, not TikTok employees. It optimizes for "what keeps you watching longest."' },
      'ch6-rabbit-sidebar': { q: 'What is the "rabbit hole" effect?', a: 'Each recommended step feels small, but the accumulated path leads somewhere unexpected. The algorithm optimizes for the NEXT video, not the whole journey.' },
      'ch6-addictive': { q: 'Name 2 design tricks that keep you scrolling.', a: 'Infinite scroll (no end point) and autoplay (next video starts automatically). These are deliberate design choices.' },
      'ch6-control-d-create': { q: 'What is the "thumbnail test"?', a: 'Pause before clicking and ask: "Do I actually WANT this?" It breaks autopilot and puts you back in control.' },
      'ch6-dopamine-sidebar': { q: 'Why does watching "just one more video" feel so hard to resist?', a: 'Dopamine! Your brain releases it for anticipation + uncertainty — the same mechanism as slot machines.' },
      'ch6-adtech-vs-recs': { q: 'What is the difference between recommendations and ads?', a: 'Recommendations help you within ONE app. Adtech tracks you across the ENTIRE internet to sell your attention.' },
      'ch6-privacy-real': { q: 'What is a "digital twin"?', a: 'A mathematical model of your behavior patterns — apps build one from your data without needing your name.' },
      'ch6-data-d-exp': { q: 'Where can you see what Google knows about you?', a: 'myactivity.google.com — shows every search, video, and click. You can also auto-delete old data there.' },
      'ch6-age-sidebar': { q: 'Can algorithms guess your age? How?', a: 'Within 3-5 years! From when you watch, how fast you scroll, music taste, and meme preferences — no personal info needed.' },
      'ch6-ai-future': { q: 'Why does YOUR generation understand algorithms better than most adults?', a: 'You grew up WITH them — you notice weird recs, know how to game the algorithm, and feel the pull of infinite scroll.' },
      'ch6-hard-d-think': { q: 'Name a hard question about algorithms that nobody has answered yet.', a: 'Should kids get different algorithms? Who defines "harmful"? Should algorithms show disagreement? No right answers exist yet.' },
      'ch6-law-sidebar': { q: 'What right did the EU give people regarding algorithms?', a: 'The right to opt OUT of algorithmic recommendations, and a ban on using kids\' personal data for targeting.' },
      'ch6-conversational': { q: 'How will LLMs change recommendations?', a: 'You\'ll ASK for what you want instead of scrolling. LLMs understand language, recommenders have the data — together they\'re powerful.' },
    };

    // Direct match by block ID
    if (QUESTIONS[id]) return QUESTIONS[id];

    // Generate from content — extract first meaningful sentence as answer
    const sentences = (block.body || '').replace(/[#*_\[\]]/g, '').split(/[.!?]\s/).filter(s => s.length > 30 && s.length < 200);
    if (sentences.length >= 2) {
      const keyIdx = Math.floor(id.charCodeAt(id.length - 1) % sentences.length);
      const answer = sentences[keyIdx].trim();
      return { q: `What did you learn about "${title}"?`, a: answer + '.' };
    }

    return { q: `What is the key idea of "${title}"?`, a: `Think about what this section explained. Try re-reading "${title}" to refresh your memory!` };
  }

  startPractice(dueOnly) {
    if (!this._f('spaceRepetition')) return;
    const due = this.user.getDueRecalls();
    let blocks;
    if (dueOnly && due.length > 0) {
      blocks = due.map(r => ({ blockId: r.blockId, isDue: true }));
    } else {
      // Smart ordering: due → learning (middle) → struggling → new → confident (sample)
      const dueSet = new Set(due.map(d => d.blockId));
      const hard = [], med = [], easy = [];
      Object.entries(this.user.recall).forEach(([blockId, card]) => {
        const item = { blockId, isDue: dueSet.has(blockId), ease: card.ease, reps: card.reps };
        if (card.ease < 1.8) hard.push(item);
        else if (card.ease < 2.5) med.push(item);
        else easy.push(item);
      });
      // Shuffle within groups for variety
      const shuffle = arr => arr.sort(() => Math.random() - 0.5);
      // Unscheduled read blocks (never reviewed)
      const recallSet = new Set(Object.keys(this.user.recall));
      const newItems = [...this.user.readBlocks]
        .filter(id => !recallSet.has(id))
        .map(id => ({ blockId: id, isDue: false, ease: 2.5, reps: 0 }));
      // Order: due first, then learning (most useful), struggling, new, then sample of confident
      const confidentSample = shuffle(easy).slice(0, Math.max(2, Math.ceil(easy.length * 0.3)));
      blocks = [...shuffle(med), ...shuffle(hard), ...shuffle(newItems), ...confidentSample];
    }
    if (blocks.length === 0) return;

    this._recallQueue = blocks;
    this._recallIdx = 0;
    this._recallScore = { total: blocks.length, correct: 0 };
    this._quizSessionActive = true;
    if (this.currentView !== 'quiz') this.switchView('quiz', true);
    this._renderQuizCard();
  }

  renderQuiz() {
    const el = document.getElementById('quizContent');
    if (!el) return;
    const u = this.user;
    const due = this._f('spaceRepetition') ? u.getDueRecalls() : [];
    const totalRecall = Object.keys(u.recall).length;
    const totalRead = u.readBlocks.size;

    // If in an active practice session started from this page, continue it
    if (this._quizSessionActive && this._recallQueue && this._recallIdx < this._recallQueue.length) {
      this._renderQuizCard();
      return;
    }
    // Otherwise reset and show landing page
    this._quizSessionActive = false;
    this._recallQueue = null;

    let h = '';

    // ── Shared single card? ──
    if (this._sharedQuizBlock) {
      const sharedId = this._sharedQuizBlock;
      this._sharedQuizBlock = null;
      const block = this.findBlock(sharedId);
      if (block) {
        const quiz = this._getRecallQuestion(block);
        if (quiz) {
          h += `<div style="padding:1em;max-width:500px;margin:0 auto">
            <p style="font-size:.75rem;color:var(--text-3);margin-bottom:.8em">Someone shared this question with you:</p>
            <div class="recall-card-big">
              <div class="recall-card-q">${quiz.q}</div>
              <div id="shared-a" style="display:none">
                <div class="recall-card-answer">${quiz.a}</div>
                <div style="margin-top:.5em;font-size:.72rem;color:var(--text-3)">From: Ch${block.meta._chapterNum} — ${block.meta.title}</div>
                <div style="display:flex;gap:.4em;margin-top:.6em">
                  <button class="btn-primary" style="flex:1;font-size:.78rem" onclick="app.openBlock('${sharedId}')">Read this section</button>
                  <button class="btn-ghost" style="flex:1;font-size:.78rem;border:1px solid var(--accent);border-radius:8px;color:var(--accent)" onclick="app.renderQuiz()">More questions</button>
                </div>
              </div>
              <button class="recall-reveal-big" onclick="document.getElementById('shared-a').style.display='block';this.style.display='none'">Think about it... then reveal!</button>
            </div>
          </div>`;
          el.innerHTML = h;
          return;
        }
      }
    }

    // ── Header ──
    h += `<div style="padding:.8em 1em .2em">
      <h2 style="font-family:var(--font-ui);font-size:1.15rem;font-weight:800">\u{1F9E0} Test Your Knowledge</h2>
      <p style="font-size:.75rem;color:var(--text-3);margin-top:.1em">Spaced repetition — review what you learned</p>
    </div>`;

    if (totalRead === 0) {
      h += `<div style="text-align:center;padding:3em 1em;color:var(--text-3)">
        <p style="font-size:2rem;margin-bottom:.3em">\u{1F4DA}</p>
        <p style="font-size:.9rem;font-weight:600">Read some sections first!</p>
        <p style="font-size:.78rem;margin:.3em 0 1em">Memory cards are created automatically as you read.</p>
        <button class="btn-primary" onclick="app.switchView('home')">Start reading</button>
      </div>`;
      el.innerHTML = h;
      return;
    }

    // ── Stats row ──
    const hardCards = Object.entries(u.recall).filter(([_, c]) => c.ease < 1.8);
    const medCards = Object.entries(u.recall).filter(([_, c]) => c.ease >= 1.8 && c.ease < 2.5);
    const easyCards = Object.entries(u.recall).filter(([_, c]) => c.ease >= 2.5);
    const totalReps = Object.values(u.recall).reduce((s, c) => s + c.reps, 0);

    // ── Active mode: due cards shelf (answerable inline) ──
    if (due.length > 0) {
      const dueCards = due.slice(0, 10).map(r => {
        const block = this.findBlock(r.blockId);
        if (!block) return '';
        const quiz = this._getRecallQuestion(block);
        if (!quiz) return '';
        const card = u.recall[r.blockId];
        const overdue = Math.round((Date.now() - card.nextReview) / 3600000);
        const reason = overdue > 24 ? `${Math.round(overdue/24)}d overdue` : overdue > 0 ? `${overdue}h overdue` : 'Due now';
        return `<div class="card recall-card" style="border-top:3px solid var(--warn);flex:0 0 280px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.3em">
            <span style="color:var(--warn);font-weight:700;font-size:.7rem">Due</span>
            <span style="color:var(--text-3);font-size:.6rem">${reason}</span>
          </div>
          <div class="card-title" style="font-size:.85rem;line-height:1.4">${quiz.q}</div>
          <div id="qd-a-${r.blockId}" style="display:none">
            <div style="font-size:.78rem;color:var(--text-2);margin:.4em 0;padding-top:.4em;border-top:1px solid var(--border)">${quiz.a}</div>
            <div style="font-size:.6rem;color:var(--text-3);margin-bottom:.3em">From: ${block.meta.title}</div>
            <div class="recall-buttons">
              <button class="recall-btn recall-forgot" onclick="app.scoreRecall('${r.blockId}',0);this.closest('.card').remove()">Forgot</button>
              <button class="recall-btn recall-hard" onclick="app.scoreRecall('${r.blockId}',1);this.closest('.card').remove()">Hard</button>
              <button class="recall-btn recall-good" onclick="app.scoreRecall('${r.blockId}',2);this.closest('.card').remove()">Good</button>
              <button class="recall-btn recall-easy" onclick="app.scoreRecall('${r.blockId}',3);this.closest('.card').remove()">Easy!</button>
            </div>
          </div>
          <button class="recall-reveal" onclick="document.getElementById('qd-a-${r.blockId}').style.display='block';this.style.display='none'" style="margin-top:.3em">Show answer</button>
        </div>`;
      }).filter(Boolean);
      if (dueCards.length) h += this.shelf(`\u{1F525} Due now (${due.length})`, dueCards);
    }

    // ── Unread blocks (haven't read yet = "Don't know") ──
    const allSpines = this.allBlocks.filter(b => b.meta.type === 'spine');
    const unreadBlocks = allSpines.filter(b => !u.readBlocks.has(b.meta.id));
    const recallSet = new Set(Object.keys(u.recall));
    const newCards = [...u.readBlocks].filter(id => !recallSet.has(id)); // read but no recall yet

    // ── Confidence map: each card is a small colored cell, hover shows title ──
    // Build ordered list: struggling → new → learning → confident → unread
    const allCards = [
      ...hardCards.map(([id, c]) => ({ id, color: '#dc2626', label: 'Struggling', q: this._getRecallQuestion(this.findBlock(id))?.q || id })),
      ...newCards.map(id => ({ id, color: 'var(--accent)', label: 'New', q: this._getRecallQuestion(this.findBlock(id))?.q || id })),
      ...medCards.map(([id, c]) => ({ id, color: 'var(--warn)', label: 'Learning', q: this._getRecallQuestion(this.findBlock(id))?.q || id })),
      ...easyCards.map(([id, c]) => ({ id, color: 'var(--product)', label: 'Confident', q: this._getRecallQuestion(this.findBlock(id))?.q || id })),
      ...unreadBlocks.map(b => ({ id: b.meta.id, color: 'var(--border)', label: 'Unread', q: b.meta.title })),
    ];
    if (allCards.length > 0) {
      const cellW = Math.max(4, Math.min(12, Math.floor((window.innerWidth - 32) / allCards.length)));
      h += `<div style="padding:.5em 1em .6em">
        <div style="display:flex;flex-wrap:wrap;gap:2px" id="quizMap">
          ${allCards.map(c => `<div style="width:${cellW}px;height:${cellW}px;border-radius:2px;background:${c.color};cursor:pointer;transition:transform .1s" title="${this.escHtml(c.label + ': ' + c.q)}" onclick="app.${c.label === 'Unread' ? "openBlock('" + c.id + "')" : "showBlockRecall('" + c.id + "')"}"></div>`).join('')}
        </div>
        <div style="display:flex;gap:.8em;font-size:.58rem;color:var(--text-3);margin-top:.4em">
          ${hardCards.length ? `<span><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:#dc2626;vertical-align:middle"></span> ${hardCards.length} struggling</span>` : ''}
          ${newCards.length ? `<span><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:var(--accent);vertical-align:middle"></span> ${newCards.length} new</span>` : ''}
          ${medCards.length ? `<span><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:var(--warn);vertical-align:middle"></span> ${medCards.length} learning</span>` : ''}
          ${easyCards.length ? `<span><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:var(--product);vertical-align:middle"></span> ${easyCards.length} confident</span>` : ''}
          ${unreadBlocks.length ? `<span><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:var(--border);vertical-align:middle"></span> ${unreadBlocks.length} unread</span>` : ''}
        </div>
      </div>`;
    }

    // ── Card swimlanes — answering moves cards between lanes ──

    // Due now (top priority)
    if (due.length > 0) {
      const dueCards = due.slice(0, 12).map(r => {
        const block = this.findBlock(r.blockId);
        if (!block) return '';
        const quiz = this._getRecallQuestion(block);
        if (!quiz) return '';
        const card = u.recall[r.blockId];
        const overdue = Math.round((Date.now() - card.nextReview) / 3600000);
        const reason = overdue > 24 ? `${Math.round(overdue/24)}d overdue` : overdue > 0 ? `${overdue}h overdue` : 'Due';
        return this._quizPreviewCard(r.blockId, card, 'var(--warn)', reason);
      }).filter(Boolean);
      if (dueCards.length) h += this.shelf(`\u{1F525} Review now (${due.length})`, dueCards);
    }

    // Struggling (ease < 1.8) — shown first, these need the most work
    if (hardCards.length > 0) {
      const hCards = hardCards.sort((a,b) => a[1].ease - b[1].ease).slice(0, 12).map(([id, c]) => this._quizPreviewCard(id, c, '#dc2626', 'Struggling')).filter(Boolean);
      if (hCards.length) h += this.shelf(`\u{1F534} Struggling (${hardCards.length})`, hCards);
    }

    // New (read but never reviewed) — important to start reviewing
    if (newCards.length > 0) {
      const nCards = newCards.slice(0, 10).map(id => {
        const block = this.findBlock(id);
        if (!block) return '';
        const quiz = this._getRecallQuestion(block);
        if (!quiz) return '';
        return this._quizPreviewCard(id, { ease: 2.5, reps: 0, nextReview: Date.now() }, 'var(--accent)', 'New');
      }).filter(Boolean);
      if (nCards.length) h += this.shelf(`\u{1F7E3} New — never tested (${newCards.length})`, nCards);
    }

    // Learning (ease 1.8-2.5) — the sweet spot for practice
    if (medCards.length > 0) {
      const mCards = medCards.sort((a,b) => a[1].ease - b[1].ease).slice(0, 12).map(([id, c]) => this._quizPreviewCard(id, c, 'var(--warn)', 'Learning')).filter(Boolean);
      if (mCards.length) h += this.shelf(`\u{1F7E1} Learning (${medCards.length})`, mCards);
    }

    // Confident (ease >= 2.5) — still shown, tested occasionally
    if (easyCards.length > 0) {
      const eCards = easyCards.sort((a,b) => b[1].ease - a[1].ease).slice(0, 10).map(([id, c]) => this._quizPreviewCard(id, c, 'var(--product)', 'Confident')).filter(Boolean);
      if (eCards.length) h += this.shelf(`\u{1F7E2} Confident (${easyCards.length})`, eCards);
    }

    // Unread — motivate reading
    if (unreadBlocks.length > 0) {
      const uCards = unreadBlocks.slice(0, 8).map(b => {
        return `<div class="card" style="border-top:3px solid var(--border);flex:0 0 240px;opacity:.7;cursor:pointer" onclick="app.openBlock('${b.meta.id}')">
          <div style="font-size:.6rem;font-weight:700;color:var(--text-3);margin-bottom:.2em">\u{1F512} Not read yet</div>
          <div class="card-title" style="font-size:.82rem;line-height:1.3">${b.meta.title}</div>
          <div style="font-size:.62rem;color:var(--text-3);margin-top:.2em">Ch${b.meta._chapterNum} · Read to unlock card</div>
        </div>`;
      });
      h += this.shelf(`\u{26AA} Haven't read yet (${unreadBlocks.length})`, uCards);
    }

    // ── How it works ──
    h += `<div style="padding:.6em 1em">
      <details style="font-size:.75rem;color:var(--text-2)">
        <summary style="cursor:pointer;font-weight:600;color:var(--text-3);font-size:.7rem">How does smart review work?</summary>
        <div style="margin-top:.5em;line-height:1.5">
          <p>Cards move between lanes based on your answers:</p>
          <ul style="padding-left:1.2em;margin:.4em 0">
            <li><strong>Forgot</strong> → card moves to Struggling, reviewed again soon</li>
            <li><strong>Hard</strong> → stays in current lane, shorter interval</li>
            <li><strong>Good</strong> → moves toward Confident, normal interval</li>
            <li><strong>Easy</strong> → moves to Confident, longer interval</li>
          </ul>
          <p>Even Confident cards come back — knowledge fades without review. The algorithm tests middle-difficulty cards most often (that's where you learn the most).</p>
        </div>
      </details>
    </div>`;

    // ── Upcoming schedule ──
    const upcoming = Object.entries(u.recall)
      .filter(([_, c]) => c.nextReview > Date.now())
      .sort((a, b) => a[1].nextReview - b[1].nextReview)
      .slice(0, 5);
    if (upcoming.length > 0) {
      h += `<div style="padding:.5em 1em">
        <div style="font-size:.7rem;font-weight:600;color:var(--text-3);margin-bottom:.3em">Upcoming reviews</div>
        ${upcoming.map(([id, c]) => {
          const b = this.findBlock(id);
          const title = b?.meta?.title || id;
          return `<div style="display:flex;align-items:center;gap:.4em;font-size:.68rem;padding:.2em 0;color:var(--text-2)">
            <span style="color:var(--warn);font-weight:600;min-width:3.5em">${this._timeUntil(c.nextReview)}</span>
            <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${this.escHtml(title)}</span>
          </div>`;
        }).join('')}
      </div>`;
    }

    // ── Bottom actions ──
    const unread = this.allBlocks.filter(b => b.meta.core && b.meta.type === 'spine' && !u.readBlocks.has(b.meta.id));
    h += `<div style="padding:.8em 1em;display:flex;flex-direction:column;gap:.5em;align-items:center">`;
    if (unread.length > 0) {
      h += `<button class="btn-primary" style="width:100%;max-width:320px;font-size:.82rem" onclick="app.switchView('home')">Continue reading \u{1F4D6} (${unread.length} unread)</button>`;
    }
    if (totalRecall > 0) {
      h += `<button class="btn-ghost" style="width:100%;max-width:320px;border:1.5px solid var(--accent);border-radius:8px;padding:.5em;font-size:.78rem;color:var(--accent)" onclick="app.startPractice()">Test all ${totalRecall} cards</button>`;
    }
    if (hardCards.length > 0) {
      h += `<button class="btn-ghost" style="width:100%;max-width:320px;border:1.5px solid #dc2626;border-radius:8px;padding:.5em;font-size:.78rem;color:#dc2626" onclick="app._startHardMode()">Hard mode (${hardCards.length} struggling)</button>`;
    }
    h += `</div>`;

    el.innerHTML = h;
  }

  _timeUntil(ts) {
    const diff = ts - Date.now();
    if (diff <= 0) return 'Due now';
    const min = Math.round(diff / 60000);
    if (min < 60) return `in ${min}m`;
    const hrs = Math.round(min / 60);
    if (hrs < 24) return `in ${hrs}h`;
    const days = Math.round(hrs / 24);
    return `in ${days}d`;
  }

  _quizPreviewCard(blockId, card, color, label) {
    const block = this.findBlock(blockId);
    if (!block) return '';
    const quiz = this._getRecallQuestion(block);
    if (!quiz) return '';
    const isDue = card.nextReview && card.nextReview <= Date.now();
    const timeLabel = card.nextReview ? (isDue ? 'Due now' : this._timeUntil(card.nextReview)) : '';
    const uid = blockId.replace(/[^a-z0-9]/g, '');
    return `<div class="card" style="border-top:3px solid ${color};flex:0 0 260px;cursor:pointer" onclick="var a=document.getElementById('qp-${uid}');if(a)a.style.display=a.style.display==='none'?'block':'none'">
      <div style="display:flex;justify-content:space-between;margin-bottom:.2em">
        <span style="font-size:.6rem;font-weight:700;color:${color}">${label}</span>
        <span style="font-size:.55rem;color:${isDue ? 'var(--warn)' : 'var(--text-3)'};font-weight:${isDue ? '600' : '400'}">${card.reps ? card.reps + 'x · ' : ''}${timeLabel}</span>
      </div>
      <div class="card-title" style="font-size:.82rem;line-height:1.3">${quiz.q}</div>
      <div style="font-size:.62rem;color:var(--text-3);margin-top:.2em">Ch${block.meta._chapterNum}: ${block.meta.title}</div>
      <div id="qp-${uid}" style="display:none;margin-top:.4em;padding-top:.4em;border-top:1px solid var(--border)">
        <div style="font-size:.78rem;color:var(--text-2);line-height:1.4;margin-bottom:.4em">${quiz.a}</div>
        <div class="recall-buttons" onclick="event.stopPropagation()">
          <button class="recall-btn recall-forgot" onclick="app.scoreRecall('${blockId}',0);this.closest('.card').remove()">Forgot</button>
          <button class="recall-btn recall-hard" onclick="app.scoreRecall('${blockId}',1);this.closest('.card').remove()">Hard</button>
          <button class="recall-btn recall-good" onclick="app.scoreRecall('${blockId}',2);this.closest('.card').remove()">Good</button>
          <button class="recall-btn recall-easy" onclick="app.scoreRecall('${blockId}',3);this.closest('.card').remove()">Easy!</button>
        </div>
        <a href="#" onclick="event.stopPropagation();event.preventDefault();app.openBlock('${blockId}')" style="display:block;font-size:.62rem;color:var(--accent);margin-top:.3em;text-align:center">Re-read this section &rarr;</a>
      </div>
    </div>`;
  }

  _startHardMode() {
    const hard = Object.entries(this.user.recall)
      .filter(([_, c]) => c.ease < 1.8)
      .sort((a, b) => a[1].ease - b[1].ease)
      .map(([blockId, card]) => ({ blockId, isDue: true, ease: card.ease, reps: card.reps }));
    if (!hard.length) return;
    this._recallQueue = hard;
    this._recallIdx = 0;
    this._recallScore = { total: hard.length, correct: 0 };
    this._quizSessionActive = true;
    this._renderQuizCard();
  }

  _renderQuizCard() {
    const q = this._recallQueue;
    const idx = this._recallIdx;
    const el = document.getElementById('quizContent');
    if (!el) return;

    // Done — show summary + rewards
    if (idx >= q.length) {
      this._quizSessionActive = false;
      const s = this._recallScore;
      const pct = Math.round(s.correct / Math.max(s.total, 1) * 100);
      const perfect = pct === 100 && s.total >= 3;
      let bonusXP = 0;
      if (this._f('gamification')) {
        bonusXP = perfect ? 15 : pct >= 70 ? 8 : 3;
        this.user.addXP(bonusXP); this.user.save(); this.updateXPBadge();
      }
      const unread = this.allBlocks.filter(b => b.meta.core && b.meta.type === 'spine' && !this.user.readBlocks.has(b.meta.id));
      el.innerHTML = `<div class="recall-session">
        <div class="recall-summary-icon">${perfect ? '\u{1F31F}' : pct >= 70 ? '\u{1F389}' : '\u{1F4AA}'}</div>
        <h2>${perfect ? 'Perfect score!' : pct >= 70 ? 'Great job!' : 'Keep going!'}</h2>
        <p style="font-size:1.1rem;font-weight:700;margin:.3em 0">${s.correct} / ${s.total} correct (${pct}%)</p>
        <div class="recall-summary-bar"><div style="width:${pct}%;background:${pct >= 70 ? 'var(--product)' : 'var(--warn)'};height:100%;border-radius:4px"></div></div>
        ${bonusXP ? `<p style="color:var(--accent);font-weight:600;margin-top:.5em">+${bonusXP} XP quiz bonus</p>` : ''}
        <div style="display:flex;flex-direction:column;gap:.5em;margin-top:1em;align-items:center">
          ${unread.length > 0 ? `<button class="btn-primary" style="width:100%;max-width:280px" onclick="app.switchView('home')">\u{1F4D6} Read new sections (${unread.length} left)</button>` : ''}
          <button class="btn-ghost" style="border:1px solid var(--accent);border-radius:8px;padding:.5em 1em;font-size:.82rem;color:var(--accent);width:100%;max-width:280px" onclick="app.startPractice()">Test more cards</button>
          <button style="font-size:.72rem;color:var(--text-3);margin-top:.3em;cursor:pointer" onclick="app._quizSessionActive=false;app._recallQueue=null;app.renderQuiz()">Back to quiz overview</button>
        </div>
      </div>`;
      return;
    }

    const item = q[idx];
    const block = this.findBlock(item.blockId);
    if (!block) { this._recallIdx++; this._renderQuizCard(); return; }
    const quiz = this._getRecallQuestion(block);
    const card = this.user.recall[item.blockId];
    const reps = card ? card.reps : 0;
    const ease = card ? card.ease.toFixed(1) : '—';
    const diffLabel = !card ? 'New' : card.ease >= 2.5 ? 'Easy' : card.ease >= 1.8 ? 'Medium' : 'Hard';
    const diffColor = !card ? 'var(--text-3)' : card.ease >= 2.5 ? 'var(--product)' : card.ease >= 1.8 ? 'var(--warn)' : '#dc2626';

    el.innerHTML = `<div class="recall-session">
      <div class="recall-progress-row">
        <span class="recall-progress-label">${idx + 1} / ${q.length}</span>
        <div class="recall-progress-bar"><div style="width:${Math.round((idx/q.length)*100)}%;background:var(--accent);height:100%;border-radius:4px;transition:width .3s"></div></div>
        ${item.isDue ? '<span class="recall-due-badge">Due</span>' : ''}
        <span style="font-size:.6rem;color:${diffColor};font-weight:600">${diffLabel}</span>
      </div>
      <div class="recall-card-big">
        <div class="recall-card-q">${quiz.q}</div>
        <div class="recall-card-a" id="recallAnswer" style="display:none">
          <div class="recall-card-answer">${quiz.a}</div>
          <div style="display:flex;justify-content:space-between;align-items:center;margin:.4em 0">
            <a href="#" onclick="event.preventDefault();app.openBlock('${item.blockId}')" style="color:var(--accent);font-size:.72rem">Ch${block.meta._chapterNum}: ${block.meta.title} &rarr;</a>
            <span style="font-size:.6rem;color:var(--text-3)">${reps}x reviewed &middot; ease ${ease}</span>
          </div>
          <div class="recall-buttons">
            <button class="recall-btn recall-forgot" onclick="app._answerRecall('${item.blockId}',0)">Forgot</button>
            <button class="recall-btn recall-hard" onclick="app._answerRecall('${item.blockId}',1)">Hard</button>
            <button class="recall-btn recall-good" onclick="app._answerRecall('${item.blockId}',2)">Good</button>
            <button class="recall-btn recall-easy" onclick="app._answerRecall('${item.blockId}',3)">Easy!</button>
          </div>
        </div>
        <button class="recall-reveal-big" id="recallRevealBtn" onclick="document.getElementById('recallAnswer').style.display='block';this.style.display='none'">Show answer</button>
      </div>
      <div style="display:flex;justify-content:center;margin-top:.8em">
        <button style="font-size:.72rem;color:var(--text-3);border:1px solid var(--border);border-radius:6px;padding:.3em .8em;cursor:pointer" onclick="app._endPractice()">Stop (${this._recallScore.correct}/${idx} correct)</button>
      </div>
    </div>`;
    window.scrollTo(0, 0);
  }

  _endPractice() {
    this._recallQueue.length = this._recallIdx;
    this._renderQuizCard(); // triggers summary (clears session via done state)
  }

  shareQuestion(blockId) {
    const block = this.findBlock(blockId);
    if (!block) return;
    const quiz = this._getRecallQuestion(block);
    if (!quiz) return;
    const url = window.location.origin + window.location.pathname + '#quiz-' + blockId;
    const text = `Can you answer this? "${quiz.q}" — from "How Recommendations Work"`;
    if (navigator.share) {
      navigator.share({ title: quiz.q, text, url }).catch(() => {});
    } else {
      navigator.clipboard.writeText(url).then(() => this.showXPToast('Link copied!', 'info'));
    }
  }

  _answerRecall(blockId, quality) {
    this.user.processRecall(blockId, quality);
    if (quality >= 2) this._recallScore.correct++;
    const labels = ['Forgot', 'Hard', 'Good!', 'Easy!'];
    this.showXPToast(labels[quality], quality >= 2 ? 'xp' : 'info');
    if (quality === 0) {
      // Forgot — show "re-read" link before moving on
      const answerEl = document.getElementById('recallAnswer');
      if (answerEl) {
        answerEl.insertAdjacentHTML('beforeend', `<div style="text-align:center;margin-top:.5em"><a href="#" onclick="event.preventDefault();app.openBlock('${blockId}')" style="color:var(--accent);font-size:.82rem;font-weight:600">Re-read this section &rarr;</a></div>`);
      }
      this._recallIdx++;
      setTimeout(() => this._renderQuizCard(), 2000);
    } else {
      this._recallIdx++;
      setTimeout(() => this._renderQuizCard(), 400);
    }
  }

  scoreRecall(blockId, quality) {
    const xpEarned = this.user.processRecall(blockId, quality);
    const labels = ['Forgot — reviewing soon!', 'Hard — keep at it!', 'Good — nice!', 'Easy — nailed it!'];
    this.showXPToast(`+${xpEarned} XP ${labels[quality]}`, quality >= 2 ? 'xp' : 'info');
    this.checkGamificationEvents();
    this.updateXPBadge();
  }

  renderMath(el) {
    const target = el || document.getElementById('readPane');
    if (!target) return;
    const doRender = () => {
      if (typeof katex === 'undefined') {
        setTimeout(() => this.renderMath(target), 200);
        return;
      }
      // Render display math
      target.querySelectorAll('.math-display').forEach(span => {
        if (span.dataset.rendered) return;
        const tex = span.textContent.replace(/^\$\$|\$\$$/g, '').trim();
        try { katex.render(tex, span, { displayMode: true, throwOnError: false, strict: false }); }
        catch(e) {}
        span.dataset.rendered = '1';
      });
      // Render inline math
      target.querySelectorAll('.math-inline').forEach(span => {
        if (span.dataset.rendered) return;
        const tex = span.textContent.replace(/^\$|\$$/g, '').trim();
        try { katex.render(tex, span, { displayMode: false, throwOnError: false, strict: false }); }
        catch(e) {}
        span.dataset.rendered = '1';
      });
    };
    setTimeout(doRender, 50);
  }

  // ===== MAP VIEW =====
  renderMap() {
    const el = document.getElementById('mapContent');
    const prog = this.user.getProgress(this.allBlocks);
    const visibleVoices = this.user.getVisibleVoices();
    const mapMode = this._mapMode || 'list';

    const summary = this.user.getSignalSummary();

    let html = `<div class="map-header fade-up">
      <h2 class="map-title">Book Map</h2>
      <div class="map-progress-summary">
        <div class="map-progress-bar"><div class="map-progress-fill" style="width:${prog.pct}%"></div></div>
        <span class="map-progress-text">${prog.read} read &middot; ${prog.seen} seen &middot; ${prog.total} total</span>
      </div>
      ${summary.views > 0 ? `<div class="map-signals-bar">
        ${summary.reads > 0 ? `<span>&#128214; ${summary.reads} read</span>` : ''}
        ${summary.views > summary.reads ? `<span>&#128065; ${summary.views - summary.reads} seen</span>` : ''}
        ${summary.ratings > 0 ? `<span>&#128293; ${summary.ratings} rated</span>` : ''}
        ${summary.saves > 0 ? `<span>&#128278; ${summary.saves} saved</span>` : ''}
        ${summary.expands > 0 ? `<span>&#128295; ${summary.expands} explored</span>` : ''}
        ${summary.dwellTotal > 60000 ? `<span>&#9201; ${Math.round(summary.dwellTotal/60000)}m reading</span>` : ''}
      </div>` : ''}
      <div class="map-mode-toggle">
        <button class="map-mode-btn ${mapMode === 'visual' ? 'active' : ''}" onclick="app.setMapMode('visual')">Visual</button>
        <button class="map-mode-btn ${mapMode === 'list' ? 'active' : ''}" onclick="app.setMapMode('list')">Detail List</button>
        <button class="map-mode-btn ${mapMode === 'saved' ? 'active' : ''}" onclick="app.setMapMode('saved')">Saved${this.user.savedBlocks.size ? ' (' + this.user.savedBlocks.size + ')' : ''}</button>
        <button class="map-mode-btn ${mapMode === 'notes' ? 'active' : ''}" onclick="app.setMapMode('notes')">Notes${this._getNoteCount() ? ' (' + this._getNoteCount() + ')' : ''}</button>
      </div>
      <button class="map-reset-btn" onclick="app.resetAll()">Reset progress</button>
    </div>`;

    if (mapMode === 'notes') {
      html += this._renderNotesList();
      el.innerHTML = html;
      return;
    }

    if (mapMode === 'saved') {
      html += this._renderSavedList();
      el.innerHTML = html;
      return;
    }

    if (mapMode === 'visual') {
      html += this.renderVisualMap(visibleVoices);
      el.innerHTML = html;
      return;
    }

    // List mode legend
    html += `<div class="map-legend">
      <span class="ml-item"><svg width="10" height="10"><circle cx="5" cy="5" r="4" fill="#059669"/></svg> Read</span>
      <span class="ml-item"><svg width="10" height="10"><circle cx="5" cy="5" r="4" fill="#E7E5E4"/></svg> Unread</span>
      <span class="ml-item"><span style="font-size:.65rem;font-weight:700;color:var(--accent);background:var(--accent-bg);padding:.1em .3em;border-radius:3px">CORE</span> Must read</span>
      <span class="ml-item"><span style="font-size:.65rem">\u{1F3AE}</span> Mini-game</span>
    </div>`;

    // Chapter reading order — which chapters should come before which
    const chapterPrereqs = {
      0: [],           // Ch1 Introduction — start here
      1: [0],          // Ch2 Data — read after Intro
      2: [0, 1],       // Ch3 Objectives — read after Intro + Data
      3: [2],          // Ch4 Scenarios — read after Objectives
      4: [2, 3],       // Ch5 Tasks — read after Objectives + Scenarios
      5: [4],          // Ch6 Algorithms — read after Tasks
      6: [2, 5]        // Ch7 Evaluation — read after Objectives + Algorithms
    };

    // Find suggested next block
    const suggestedNext = this.getSuggestedNext(chapterPrereqs);

    this.book.chapters.forEach((ch, ci) => {
      const blocks = this.chapters[ci]?.blocks || [];
      const allItems = blocks.filter(b => b.type === 'spine' || b.type === 'game');
      const readCount = allItems.filter(b => this.user.readBlocks.has(b.id)).length;
      const coreCount = allItems.filter(b => b.core).length;
      const coreRead = allItems.filter(b => b.core && this.user.readBlocks.has(b.id)).length;
      const totalCount = allItems.length;
      const chPct = Math.round((readCount / Math.max(totalCount, 1)) * 100);

      html += `<div class="map-chapter fade-up">`;

      html += `<div class="map-ch-head" onclick="app.goChapter(${ci})">
        <div class="map-ch-ring" data-pct="${chPct}">
          <svg viewBox="0 0 36 36"><circle cx="18" cy="18" r="16" fill="none" stroke="var(--border)" stroke-width="2.5"/>
          <circle cx="18" cy="18" r="16" fill="none" stroke="${chPct === 100 ? 'var(--product)' : 'var(--accent)'}" stroke-width="2.5" stroke-dasharray="${chPct} ${100 - chPct}" stroke-dashoffset="25" stroke-linecap="round"/></svg>
          <span class="map-ch-num">${ch.number}</span>
        </div>
        <div class="map-ch-info">
          <div class="map-ch-title">${ch.title}</div>
          <div class="map-ch-sub">${ch.subtitle}</div>
          <div class="map-ch-stats">${readCount}/${totalCount} read &middot; ${coreRead}/${coreCount} core</div>
        </div>
        <div class="map-ch-arrow">&rsaquo;</div>
      </div>`;

      // All blocks: spine + game + question
      html += '<div class="map-blocks">';
      allItems.forEach(item => {
        const isRead = this.user.readBlocks.has(item.id);
        const isCore = item.core;
        const isGame = item.type === 'game';
        const icon = isGame ? '\u{1F3AE}' : isCore ? '\u{25CF}' : '\u{25CB}';
        const badge = isCore ? '<span class="map-core-badge">CORE</span>' : '';
        const gameTag = isGame ? '<span class="map-game-tag">\u{1F3AE}</span>' : '';

        html += `<div class="map-block ${isRead ? 'read' : ''}" onclick="app.openBlock('${item.id}')">
          <div class="map-dot ${isRead ? 'done' : ''}"></div>
          <span class="map-block-title">${item.title}</span>
          ${badge}${gameTag}
          <span class="map-block-time">${item.readingTime || 3}m</span>
        </div>`;
      });
      // Questions
      blocks.filter(b => b.type === 'question').forEach(q => {
        html += `<div class="map-block" onclick="app.openBlock('${q.id}')">
          <div class="map-dot" style="background:var(--accent)"></div>
          <span class="map-block-title">${q.title}</span>
          <span class="map-game-tag">\u{2753}</span>
        </div>`;
      });
      html += '</div></div>';
    });

    el.innerHTML = html;
  }

  getSuggestedNext(prereqs) {
    for (let ci = 0; ci < this.book.chapters.length; ci++) {
      const blocks = this.chapters[ci]?.blocks || [];
      const spines = blocks.filter(b => b.type === 'spine');
      const next = spines.find(b => !this.user.readBlocks.has(b.id));
      if (next) return next.id;
    }
    return null;
  }

  setMapMode(mode) { this._mapMode = mode; this.renderMap(); }

  _renderSavedList() {
    const savedIds = [...this.user.savedBlocks];
    const saved = savedIds.map(id => this.findBlock(id)).filter(Boolean);

    if (!saved.length) {
      return `<div style="text-align:center;padding:2em;color:var(--text-3);background:var(--surface);border:1px solid var(--border);border-radius:var(--radius)">
        <p style="font-size:1.5rem;margin-bottom:.3em">&#128278;</p>
        <p style="font-size:.85rem;font-weight:600">No saved items yet</p>
        <p style="font-size:.78rem;color:var(--text-3);margin-top:.2em">Tap the bookmark icon on any section to save it for later.</p>
      </div>`;
    }

    let html = `<div style="font-size:.82rem;color:var(--text-2);margin-bottom:.8em">${saved.length} saved item${saved.length !== 1 ? 's' : ''} — tap to read, swipe to remove</div>`;
    html += '<div class="map-blocks">';
    saved.reverse().forEach(b => {
      const isRead = this.user.readBlocks.has(b.meta.id);
      const isCore = b.meta.core;
      html += `<div class="map-block ${isRead ? 'read' : ''}" style="position:relative" onclick="app.openBlock('${b.meta.id}')">
        <div class="map-dot ${isRead ? 'done' : ''}"></div>
        <span class="map-block-title">${b.meta.title}</span>
        ${isCore ? '<span class="map-core-badge">CORE</span>' : ''}
        <span style="font-size:.65rem;color:var(--text-3)">Ch${b.meta._chapterNum}</span>
        <button class="saved-remove-btn" onclick="event.stopPropagation();app.unsaveBlock('${b.meta.id}')" title="Remove from saved">&times;</button>
      </div>`;
    });
    html += '</div>';
    return html;
  }

  unsaveBlock(blockId) {
    this.user.savedBlocks.delete(blockId);
    this.user.save();
    this.renderMap();
  }

  _getNoteCount() {
    try {
      const store = JSON.parse(localStorage.getItem('pbook-notes') || '{}');
      let count = 0;
      for (const val of Object.values(store)) {
        count += Array.isArray(val) ? val.length : (val ? 1 : 0);
      }
      return count;
    } catch(e) { return 0; }
  }

  _renderNotesList() {
    let store = {};
    try { store = JSON.parse(localStorage.getItem('pbook-notes') || '{}'); } catch(e) {}

    // Flatten all notes across blocks into a list
    const allNotes = [];
    for (const [blockId, val] of Object.entries(store)) {
      const arr = typeof val === 'string' ? [{ text: val, quote: '', ts: 0 }] : (Array.isArray(val) ? val : []);
      arr.forEach((n, idx) => allNotes.push({ blockId, ...n, idx }));
    }
    // Sort newest first
    allNotes.sort((a, b) => (b.ts || 0) - (a.ts || 0));

    if (!allNotes.length) {
      return `<div style="text-align:center;padding:2em;color:var(--text-3);background:var(--surface);border:1px solid var(--border);border-radius:var(--radius)">
        <p style="font-size:1.5rem;margin-bottom:.3em">&#128221;</p>
        <p style="font-size:.85rem;font-weight:600">No notes yet</p>
        <p style="font-size:.78rem;color:var(--text-3);margin-top:.2em">Select text and tap "Highlight + Note", or tap the note icon on any section.</p>
      </div>`;
    }

    let html = `<div style="font-size:.82rem;color:var(--text-2);margin-bottom:.8em">${allNotes.length} note${allNotes.length !== 1 ? 's' : ''}</div>`;
    html += '<div class="map-blocks">';
    allNotes.forEach(n => {
      const block = this.findBlock(n.blockId);
      const title = block?.meta?.title || n.blockId;
      const ch = block?.meta?._chapterNum || '?';
      const quoteHtml = n.quote ? `<div style="font-size:.72rem;color:var(--accent);font-style:italic;padding-left:1.6em;line-height:1.3;margin-bottom:.15em">"${this.escHtml(n.quote.substring(0, 120))}${n.quote.length > 120 ? '...' : ''}"</div>` : '';
      const textHtml = n.text ? `<div style="font-size:.78rem;color:var(--text-2);padding-left:1.6em;line-height:1.35">${this.escHtml(n.text.substring(0, 150))}${n.text.length > 150 ? '...' : ''}</div>` : '';
      html += `<div class="map-block" style="flex-direction:column;align-items:stretch;gap:.2em;cursor:pointer" onclick="app.openBlock('${n.blockId}')">
        <div style="display:flex;align-items:center;gap:.4em">
          <div class="map-dot ${this.user.readBlocks.has(n.blockId) ? 'done' : ''}"></div>
          <span class="map-block-title">${title}</span>
          <span style="font-size:.65rem;color:var(--text-3)">Ch${ch}</span>
          <button class="saved-remove-btn" onclick="event.stopPropagation();app.deleteUserNote('${n.blockId}',${n.idx});app.renderMap()" title="Delete note">&times;</button>
        </div>
        ${quoteHtml}${textHtml}
      </div>`;
    });
    html += '</div>';
    return html;
  }




  // ===== VISUAL RPG MAP =====
  renderVisualMap(visibleVoices) {
    // Build prereqs and layout dynamically from book chapters
    const numCh = this.book.chapters.length;
    const chapterPrereqs = {};
    for (let i = 0; i < numCh; i++) {
      chapterPrereqs[i] = i === 0 ? [] : [i - 1]; // linear: each chapter requires the previous
    }
    const suggestedNext = this.getSuggestedNext(chapterPrereqs);

    // Layout: position chapters dynamically on a grid
    const layout = this.book.chapters.map((ch, i) => {
      const cols = Math.min(numCh, 4);
      const row = Math.floor(i / cols);
      const col = i % cols;
      return { ci: i, x: 50 + col * 170, y: 40 + row * 80, label: ch.title.split(/[:(]/)[0].trim().substring(0, 14) };
    });

    // Connections: linear chain
    const connections = [];
    for (let i = 0; i < numCh - 1; i++) connections.push([i, i + 1]);

    // Compute stats per chapter
    const chData = layout.map(l => {
      const blocks = this.chapters[l.ci]?.blocks || [];
      const spines = blocks.filter(b => b.type === 'spine');
      const depths = blocks.filter(b => b.type === 'depth');
      const readSpines = spines.filter(b => this.user.readBlocks.has(b.id)).length;
      const total = spines.length;
      const pct = Math.round((readSpines / Math.max(total, 1)) * 100);
      const hasNext = spines.some(b => b.id === suggestedNext);
      const depthCount = depths.filter(d => visibleVoices.includes(d.voice)).length;
      const savedCount = spines.filter(b => this.user.savedBlocks.has(b.id)).length;
      const ratedCount = spines.filter(b => this.user.ratings.has(b.id) && this.user.ratings.get(b.id) >= 0.7).length;
      return { ...l, spines, depths, readSpines, total, pct, hasNext, depthCount, savedCount, ratedCount };
    });

    const cols = Math.min(numCh, 4);
    const rows = Math.ceil(numCh / cols);
    const W = Math.max(680, 50 + cols * 170), H = 40 + rows * 80 + 60;
    let svg = `<div class="visual-map-wrap"><svg viewBox="0 0 ${W} ${H}" class="visual-map">`;

    // Background grid pattern
    svg += `<defs>
      <pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse"><path d="M 20 0 L 0 0 0 20" fill="none" stroke="var(--border)" stroke-width="0.3" opacity="0.5"/></pattern>
      <filter id="glow"><feGaussianBlur stdDeviation="3" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    </defs>
    <rect width="${W}" height="${H}" fill="url(#grid)" rx="12"/>`;

    // Draw connections first (behind nodes)
    connections.forEach(([from, to]) => {
      const a = chData[from], b = chData[to];
      const ax = a.x + 40, ay = a.y + 15;
      const bx = b.x, by = b.y + 15;
      // Curved path
      const mx = (ax + bx) / 2, my = (ay + by) / 2;
      const color = a.pct >= 50 ? 'var(--product)' : 'var(--border)';
      const opacity = a.pct >= 50 ? '0.6' : '0.3';
      svg += `<path d="M${ax},${ay} Q${mx},${ay} ${bx},${by}" fill="none" stroke="${color}" stroke-width="2" opacity="${opacity}" stroke-dasharray="${a.pct >= 50 ? 'none' : '4 4'}"/>`;
    });

    // Draw chapter nodes
    chData.forEach(ch => {
      const nodeW = 110, nodeH = 50;
      const isComplete = ch.pct === 100;
      const isStarted = ch.readSpines > 0;
      const isNext = ch.hasNext;

      // Node background
      const fillColor = isComplete ? 'var(--product-bg)' : isStarted ? 'var(--accent-bg)' : 'var(--surface)';
      const strokeColor = isComplete ? 'var(--product)' : isNext ? 'var(--accent)' : 'var(--border)';
      const strokeW = isNext ? '2' : '1.5';

      svg += `<g class="map-node" onclick="app.goChapter(${ch.ci})" style="cursor:pointer">`;

      // Glow for suggested next
      if (isNext) {
        svg += `<rect x="${ch.x - 4}" y="${ch.y - 4}" width="${nodeW + 8}" height="${nodeH + 8}" rx="14" fill="var(--accent)" opacity="0.12"/>`;
      }

      // Main rect
      svg += `<rect x="${ch.x}" y="${ch.y}" width="${nodeW}" height="${nodeH}" rx="10" fill="${fillColor}" stroke="${strokeColor}" stroke-width="${strokeW}"/>`;

      // Chapter number badge
      const badgeColor = isComplete ? 'var(--product)' : 'var(--accent)';
      svg += `<circle cx="${ch.x + 14}" cy="${ch.y + 14}" r="9" fill="${badgeColor}"/>`;
      svg += `<text x="${ch.x + 14}" y="${ch.y + 18}" text-anchor="middle" font-family="system-ui" font-size="9" font-weight="700" fill="white">${this.book.chapters[ch.ci].number}</text>`;

      // Title
      svg += `<text x="${ch.x + 28}" y="${ch.y + 17}" font-family="system-ui" font-size="9.5" font-weight="700" fill="var(--text)">${ch.label}</text>`;

      // Progress bar inside node
      const barX = ch.x + 8, barY = ch.y + 28, barW = nodeW - 16, barH = 4;
      svg += `<rect x="${barX}" y="${barY}" width="${barW}" height="${barH}" rx="2" fill="var(--border)"/>`;
      svg += `<rect x="${barX}" y="${barY}" width="${barW * ch.pct / 100}" height="${barH}" rx="2" fill="${isComplete ? 'var(--product)' : 'var(--accent)'}"/>`;

      // Stats line
      svg += `<text x="${ch.x + 8}" y="${ch.y + 44}" font-family="system-ui" font-size="7.5" fill="var(--text-3)">${ch.readSpines}/${ch.total} spine`;
      if (ch.depthCount > 0) svg += ` · ${ch.depthCount} depth`;
      svg += `</text>`;

      // Icons for saved/liked
      let iconX = ch.x + nodeW - 8;
      if (ch.savedCount > 0) {
        svg += `<text x="${iconX}" y="${ch.y + 44}" text-anchor="end" font-size="8">&#128278;${ch.savedCount}</text>`;
        iconX -= 20;
      }
      if (ch.ratedCount > 0) {
        svg += `<text x="${iconX}" y="${ch.y + 44}" text-anchor="end" font-size="8">&#128293;${ch.ratedCount}</text>`;
      }

      svg += '</g>';
    });

    svg += '</svg>';

    // Legend below SVG
    svg += `<div class="vmap-legend">
      <span><svg width="12" height="12"><rect width="12" height="12" rx="3" fill="var(--product-bg)" stroke="var(--product)" stroke-width="1.5"/></svg> Complete</span>
      <span><svg width="16" height="16"><rect x="2" y="2" width="12" height="12" rx="3" fill="var(--accent-bg)" stroke="var(--accent)" stroke-width="2"/></svg> In progress / Next</span>
      <span><svg width="12" height="12"><rect width="12" height="12" rx="3" fill="var(--surface)" stroke="var(--border)" stroke-width="1.5"/></svg> Not started</span>
      <span>&#128278; Saved</span>
      <span>&#128293; Liked</span>
      <span style="color:var(--text-3)">--- Prerequisites not met</span>
    </div>`;

    // Spine block detail below (expandable per chapter)
    svg += '<div class="vmap-detail" id="vmapDetail"></div>';
    svg += '</div>';
    return svg;
  }

  // ===== PROFILE VIEW =====
  renderProfile() {
    const el = document.getElementById('profileContent');
    const p = this.user.getProfile(this.allBlocks);
    const u = this.user;

    let h = '';

    // ---- Account indicator (compact — full login form is in Settings) ----
    const auth = this._getAuth();
    h += '<div class="profile-section">';
    if (auth) {
      h += `<div class="auth-card auth-logged-in">
        <div class="auth-avatar">${this.getLevelIcon()}</div>
        <div class="auth-info">
          <div class="auth-name">${this.escHtml(auth.displayName || 'Reader')}</div>
          <div class="auth-email"><span style="color:var(--product)">&#9679;</span> Synced &middot; ${this.escHtml(auth.email)}</div>
        </div>
        <button class="auth-sync-btn" onclick="app.syncProfile()" id="syncBtn">Sync</button>
      </div>`;
    } else {
      h += `<div class="auth-card" style="display:flex;align-items:center;gap:.8em">
        <span style="color:var(--text-3);font-size:1.2rem">&#9888;</span>
        <div style="flex:1">
          <div style="font-size:.82rem;font-weight:600">Not logged in</div>
          <div style="font-size:.72rem;color:var(--text-3)">Your progress is saved locally only.</div>
        </div>
        <button class="auth-primary-btn" style="flex:0 0 auto;padding:.4em .8em;font-size:.75rem" onclick="app.toggleSettings()">Log in</button>
      </div>`;
    }
    h += '</div>';

    // Level & XP hero card (gamification only)
    if (!this._f('gamification')) {
      h += `<div class="profile-section"><h3>Reading Progress</h3><p style="font-size:.85rem">${p.progress.read} of ${p.progress.total} sections read (${p.progress.pct}%)</p><p style="font-size:.8rem;color:var(--text-2)">${p.readingTimeMin} min total reading time</p></div>`;
    } else {
    const xpInLevel = u.getXPInCurrentLevel();
    const xpNeeded = u.getXPForNextLevel();
    const xpPct = Math.min(100, Math.round((xpInLevel / xpNeeded) * 100));
    h += `<div class="gami-hero">
      <div class="gami-level">Lv.${u.level}</div>
      <div class="gami-info">
        <div class="gami-title">${u.getLevelTitle()}</div>
        <div class="gami-xp-bar"><div class="gami-xp-fill" style="width:${xpPct}%"></div></div>
        <div class="gami-xp-text">${u.xp} XP &middot; ${xpNeeded - xpInLevel} XP to level ${u.level + 1}</div>
      </div>
    </div>`;

    // Quick stats row
    const dueCount = u.getDueRecalls().length;
    const totalRecall = Object.keys(u.recall).length;
    const totalReps = Object.values(u.recall).reduce((s, c) => s + c.reps, 0);
    h += `<div class="gami-stats">
      <div class="gami-stat"><span class="gs-num">${p.progress.read}</span><span class="gs-label">Read</span></div>
      <div class="gami-stat"><span class="gs-num">${p.progress.pct}%</span><span class="gs-label">Done</span></div>
      <div class="gami-stat"><span class="gs-num">${u.achievements.length}</span><span class="gs-label">Badges</span></div>
      <div class="gami-stat"><span class="gs-num">${p.readingTimeMin}</span><span class="gs-label">Min read</span></div>
    </div>`;

    // Recall section
    if (this._f('spaceRepetition') && totalRecall > 0) {
      h += '<div class="profile-section"><h3>\u{1F9E0} Recall & Review</h3>';
      h += `<div class="gami-stats">
        <div class="gami-stat"><span class="gs-num">${dueCount}</span><span class="gs-label">Due now</span></div>
        <div class="gami-stat"><span class="gs-num">${totalRecall}</span><span class="gs-label">Tracked</span></div>
        <div class="gami-stat"><span class="gs-num">${totalReps}</span><span class="gs-label">Reviews</span></div>
      </div>`;
      // Show up to 3 due recall cards directly in profile
      const dueInProfile = u.getDueRecalls().slice(0, 3);
      if (dueInProfile.length) {
        h += '<div style="margin:.6em 0">';
        dueInProfile.forEach(r => {
          const block = this.findBlock(r.blockId);
          if (!block) return;
          const quiz = this._getRecallQuestion(block);
          if (!quiz) return;
          h += `<div class="inline-recall" style="margin-bottom:.5em">
            <div class="ir-header"><span class="ir-icon">\u{1F9E0}</span> Do you remember?</div>
            <div class="ir-question">${quiz.q}</div>
            <div class="ir-answer" id="pr-a-${r.blockId}" style="display:none">
              <div class="ir-answer-text">${quiz.a}</div>
              <div class="ir-from">From: ${block.meta.title}</div>
              <div class="recall-buttons">
                <button class="recall-btn recall-forgot" onclick="app.scoreRecall('${r.blockId}',0);document.getElementById('pr-a-${r.blockId}').closest('.inline-recall').remove()">Forgot</button>
                <button class="recall-btn recall-hard" onclick="app.scoreRecall('${r.blockId}',1);document.getElementById('pr-a-${r.blockId}').closest('.inline-recall').remove()">Hard</button>
                <button class="recall-btn recall-good" onclick="app.scoreRecall('${r.blockId}',2);document.getElementById('pr-a-${r.blockId}').closest('.inline-recall').remove()">Good</button>
                <button class="recall-btn recall-easy" onclick="app.scoreRecall('${r.blockId}',3);document.getElementById('pr-a-${r.blockId}').closest('.inline-recall').remove()">Easy!</button>
              </div>
            </div>
            <button class="recall-reveal" onclick="document.getElementById('pr-a-${r.blockId}').style.display='block';this.style.display='none'">Show answer</button>
          </div>`;
        });
        h += '</div>';
      }
      h += `<div style="display:flex;gap:.4em;justify-content:center;margin-top:.5em">`;
      if (dueCount > 0) h += `<button class="recall-reveal" onclick="app.startPractice(true)">\u{1F9E0} Review ${dueCount} due card${dueCount > 1 ? 's' : ''}</button>`;
      h += `<button class="btn-ghost" style="border:1px solid var(--accent);border-radius:6px;padding:.3em .7em;font-size:.75rem;color:var(--accent)" onclick="app.startPractice()">\u{1F9E0} Test knowledge (${totalRecall})</button>`;
      h += `</div></div>`;
    } else if (this._f('spaceRepetition')) {
      h += '<div class="profile-section"><h3>\u{1F9E0} Recall & Review</h3><p style="font-size:.8rem;color:var(--text-3)">Read some sections first — recall quizzes will appear to help you remember.</p></div>';
    }

    // Achievements
    h += '<div class="profile-section"><h3>&#127942; Achievements</h3>';
    if (u.achievements.length) {
      h += '<div class="gami-badges">';
      u.achievements.forEach(a => {
        h += `<div class="gami-badge earned" title="${a.desc}"><span class="badge-icon">${a.icon}</span><span class="badge-name">${a.name}</span></div>`;
      });
      h += '</div>';
    }
    // Show locked achievements
    const earnedIds = new Set(u.achievements.map(a => a.id));
    const allBadges = [
      { id: 'first_read', icon: '👣', name: 'First Steps' }, { id: 'reader_5', icon: '📚', name: 'Bookworm' },
      { id: 'reader_15', icon: '⚡', name: 'Speed Reader' }, { id: 'reader_30', icon: '🤖', name: 'Knowledge Machine' },
      { id: 'first_like', icon: '❤️', name: 'Thumbs Up' }, { id: 'like_10', icon: '🌟', name: 'Super Fan' },
      { id: 'first_note', icon: '📝', name: 'Note Taker' }, { id: 'voice_all', icon: '🎭', name: 'Triple Threat' },
      { id: 'curious_cat', icon: '🐱', name: 'Curious Cat' }, { id: 'quiz_master', icon: '🧩', name: 'Quiz Master' },
      { id: 'level_5', icon: '🏆', name: 'Level 5!' }, { id: 'save_5', icon: '🔖', name: 'Collector' },
      { id: 'xp_200', icon: '💎', name: 'XP Hunter' }, { id: 'deep_diver', icon: '🤿', name: 'Deep Diver' },
      { id: 'recall_5', icon: '🧠', name: 'Memory Pro' },
      { id: 'certified', icon: '🎓', name: 'Certified!' },
    ];
    const locked = allBadges.filter(a => !earnedIds.has(a.id));
    if (locked.length) {
      h += '<div class="gami-badges">';
      locked.forEach(a => { h += `<div class="gami-badge locked"><span class="badge-icon">🔒</span><span class="badge-name">${a.name}</span></div>`; });
      h += '</div>';
    }
    h += '</div>';

    // XP breakdown
    h += '<div class="profile-section"><h3>How to earn XP</h3>';
    h += '<div style="font-size:.8rem;display:grid;grid-template-columns:auto 1fr;gap:.3em .8em">';
    h += '<span style="font-weight:600;color:var(--accent)">+10 XP</span><span>Read a section</span>';
    h += '<span style="font-weight:600;color:var(--accent)">+5 XP</span><span>Explore a depth card</span>';
    h += '<span style="font-weight:600;color:var(--accent)">+5 XP</span><span>Write a note</span>';
    h += '<span style="font-weight:600;color:var(--accent)">+3 XP</span><span>Like a section</span>';
    h += '<span style="font-weight:600;color:var(--accent)">+2 XP</span><span>Save for later</span>';
    h += '<span style="font-weight:600;color:#F59E0B">+2-8 XP</span><span>Recall review (depends on how well you remember)</span>';
    h += '</div></div>';


    // Voice preference
    const voices = Object.keys(CONFIG.voices);
    if (voices.length) {
      h += '<div class="profile-section"><h3>Your Style</h3>';
      const totalV = voices.reduce((s, v) => s + (u.voiceScores[v] || 0), 0) || 1;
      voices.forEach(v => {
        const pct = Math.round(((u.voiceScores[v] || 0) / totalV) * 100);
        const vc = CONFIG.voices[v] || {};
        h += `<div class="voice-bar"><span class="voice-bar-label">${vc.icon || ''} ${vc.label || v}</span><div style="flex:1;height:6px;background:var(--border);border-radius:3px"><div class="voice-bar-fill" style="width:${pct}%;background:var(--accent)"></div></div><span style="font-size:.72rem;color:var(--text-3);width:2.5em;text-align:right">${pct}%</span></div>`;
      });
      h += '</div>';
    }

    // Activity heatmap (last 8 weeks, GitHub-style, inline SVG)
    h += this._renderActivityHeatmap();

    // Knowledge cloud — extract terms from read blocks
    const termCounts = {};
    const CLOUD_TERMS = {
      'Collaborative Filtering': ['collaborative filter'],
      'Content-Based': ['content-based', 'content based'],
      'Cold Start': ['cold start', 'cold-start'],
      'Filter Bubble': ['filter bubble', 'bubble'],
      'Echo Chamber': ['echo chamber'],
      'A/B Testing': ['a/b test', 'ab test'],
      'Digital Footprints': ['footprint', 'digital footprint'],
      'Pipeline': ['pipeline', 'candidate generation'],
      'Popularity Bias': ['popular', 'trending', 'popularity'],
      'Privacy': ['privacy', 'gdpr', 'data protection'],
      'Tracking': ['tracker', 'cookie', 'tracking'],
      'Dopamine Loop': ['dopamine'],
      'Autoplay': ['autoplay', 'infinite scroll'],
      'Fairness': ['fair', 'unfair', 'bias'],
      'Diversity': ['diversity', 'long tail', 'coverage'],
      'Algorithms': ['algorithm'],
      'Recommendations': ['recommend', 'suggestion'],
      'User Signals': ['signal', 'implicit', 'explicit'],
      'Ratings': ['rating', 'stars', 'score'],
      'Similarity': ['similar', 'cosine', 'taste twin'],
      'Matrix Factorization': ['matrix factor', 'svd', 'latent'],
      'Machine Learning': ['machine learn', 'neural', 'deep learn'],
      'YouTube': ['youtube'],
      'TikTok': ['tiktok'],
      'Netflix': ['netflix'],
      'Spotify': ['spotify'],
      'Personalization': ['personali', 'personal'],
      'Data Collection': ['data collect', 'item catalog', 'user data'],
      'Exploration': ['exploration', 'exploit', 'bandit'],
      'Ethics': ['ethic', 'responsible', 'transparent'],
    };
    [...u.readBlocks].forEach(id => {
      const block = this.findBlock(id);
      if (!block) return;
      const text = ((block.meta.title || '') + ' ' + (block.body || '')).toLowerCase();
      for (const [term, keywords] of Object.entries(CLOUD_TERMS)) {
        if (keywords.some(kw => text.includes(kw))) termCounts[term] = (termCounts[term] || 0) + 1;
      }
    });
    const cloudEntries = Object.entries(termCounts).sort((a, b) => b[1] - a[1]);
    if (cloudEntries.length > 0) {
      h += '<div class="profile-section"><h3>Your Knowledge</h3>';
      h += '<div class="knowledge-cloud">';
      const maxCount = Math.max(cloudEntries[0][1], 1);
      cloudEntries.forEach(([term, count]) => {
        const weight = count / maxCount;
        const size = 0.6 + weight * 0.55;
        const opacity = 0.35 + weight * 0.65;
        h += `<span class="cloud-word" style="font-size:${size}rem;opacity:${opacity}">${term}</span>`;
      });
      h += '</div></div>';
    }

    // Certificate — requires all CORE blocks read
    const coreBlocks = this.allBlocks.filter(b => b.meta.core);
    const coreRead = coreBlocks.filter(b => u.readBlocks.has(b.meta.id)).length;
    const coreTotal = coreBlocks.length;
    const certReady = coreRead >= coreTotal && coreTotal > 0;
    h += '<div class="profile-section"><h3>Certificate</h3>';
    if (certReady) {
      const savedName = localStorage.getItem('pbook-cert-name') || '';
      h += `<div class="cert-ready">
        <p style="font-size:.85rem;margin-bottom:.6em">You've read all <strong>${coreTotal} core sections</strong>. You've earned your certificate!</p>
        <button class="cert-btn" onclick="app.showCertificateModal()">Get Your Certificate</button>
        ${savedName ? `<p style="font-size:.75rem;color:var(--text-3);margin-top:.4em">Certificate issued to: ${this.escHtml(savedName)}</p>` : ''}
      </div>`;
    } else {
      h += `<div class="cert-locked">
        <p style="font-size:.85rem;color:var(--text-2)">Read all core sections to earn your certificate!</p>
        <div style="font-size:.8rem;color:var(--text-3);margin-top:.3em">${coreRead}/${coreTotal} core sections read</div>
        <div class="cert-progress">
          <div class="cert-progress-fill" style="width:${Math.round((coreRead / Math.max(coreTotal, 1)) * 100)}%"></div>
        </div>
      </div>`;
    }
    h += '</div>';
    } // end gamification guard

    // Settings link
    h += '<div class="profile-section" style="text-align:center">';
    h += '<button class="btn-ghost" style="border:1px solid var(--border);border-radius:6px;padding:.4em 1em;font-size:.78rem;color:var(--text-2)" onclick="app.toggleSettings()">&#9881; Settings &amp; data</button>';
    h += '</div>';

    el.innerHTML = h;
  }

  // ===== ACCOUNT & SYNC =====
  _syncUserToRecombee() {
    if (!this.rc.enabled) return;
    const u = this.user;
    const prog = u.getProgress(this.allBlocks);
    this.rc.setUserProperties({
      voice: u.preferredVoice || u.getTopVoice(),
      level: u.level,
      xp: u.xp,
      readCount: prog.read,
      totalBlocks: prog.total,
      completedMissions: (u.completedMissions || []).length,
      activePath: u.activePath || '',
    });
  }

  _refreshAfterAuth() {
    // Reload user model from (merged) localStorage and refresh all views
    this.user.load();
    this.updateXPBadge();
    this.renderProfile();
    // If user was on home, re-render to pick up new recs
    if (this.currentView === 'home') this.renderHome();
  }

  _authEndpoint() {
    // Detect Netlify vs Vercel
    if (location.hostname.includes('netlify')) return '/.netlify/functions/auth';
    return '/api/auth';
  }

  _getAuth() {
    try {
      const s = localStorage.getItem('pbook-auth');
      return s ? JSON.parse(s) : null;
    } catch { return null; }
  }

  _setAuth(auth) {
    if (auth) localStorage.setItem('pbook-auth', JSON.stringify(auth));
    else localStorage.removeItem('pbook-auth');
  }

  async _authRequest(body) {
    const res = await fetch(this._authEndpoint(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.json();
  }

  _collectProfileData() {
    // Gather all localStorage keys that should sync
    const data = {};
    const keys = ['pbook-user', 'pbook-notes', 'pbook-highlights', 'pbook-interactions',
                  'pbook-uid', 'pbook-tour-done', 'pbook-cert-name', 'pbook-cert-email',
                  'pbook-content-statuses', 'pbook-flags'];
    keys.forEach(k => {
      const v = localStorage.getItem(k);
      if (v) data[k] = v;
    });
    // Feature toggles
    ['sGamification', 'sPersonalization', 'sSpaceRepetition', 'sMissions', 'sGames', 'sHighlights'].forEach(k => {
      const v = localStorage.getItem(k);
      if (v !== null) data[k] = v;
    });
    return data;
  }

  _restoreProfileData(data) {
    if (!data || typeof data !== 'object') return;
    Object.entries(data).forEach(([k, v]) => {
      if (v !== null && v !== undefined) localStorage.setItem(k, v);
    });
    // Reload user model from restored localStorage
    this.user.load();
  }

  async register() {
    const name = document.getElementById('authName')?.value?.trim();
    const email = document.getElementById('authEmail')?.value?.trim();
    const password = document.getElementById('authPassword')?.value;
    const errEl = document.getElementById('authError');

    if (!email || !password) { errEl.textContent = 'Email and password are required.'; return; }
    if (password.length < 4) { errEl.textContent = 'Password must be at least 4 characters.'; return; }
    errEl.textContent = 'Creating account...';

    const result = await this._authRequest({
      action: 'register', email, password,
      displayName: name || undefined,
      profileData: this._collectProfileData(),
    });

    if (result.error) { errEl.textContent = result.error; return; }

    this._setAuth({ email, token: result.token, displayName: result.displayName || name });
    if (name) localStorage.setItem('pbook-cert-name', name);

    // Switch Recombee identity: merge anonymous → account user
    const accountUid = 'acct-' + email.toLowerCase().trim().replace(/[^a-z0-9]/g, '-');
    await this.rc.switchUser(accountUid);
    // Re-sync user properties to Recombee under new identity
    this._syncUserToRecombee();

    this._lastSyncTime = Date.now();
    this.showXPToast('Account created! Your progress is now synced.', 'info');
    this._refreshAfterAuth();
  }

  async login() {
    const email = document.getElementById('authEmail')?.value?.trim();
    const password = document.getElementById('authPassword')?.value;
    const errEl = document.getElementById('authError');

    if (!email || !password) { errEl.textContent = 'Email and password are required.'; return; }
    errEl.textContent = 'Logging in...';

    const result = await this._authRequest({ action: 'login', email, password });
    if (result.error) { errEl.textContent = result.error; return; }

    this._setAuth({ email, token: result.token, displayName: result.displayName });

    // Merge cloud profile with local — cloud wins for reading progress (union of sets)
    if (result.profileData && Object.keys(result.profileData).length > 0) {
      const cloudData = result.profileData;
      // Merge user model: take union of read/seen/saved blocks
      try {
        const localUser = JSON.parse(localStorage.getItem('pbook-user') || '{}');
        const cloudUser = JSON.parse(cloudData['pbook-user'] || '{}');
        if (cloudUser.readBlocks) {
          const merged = new Set([...(localUser.readBlocks || []), ...cloudUser.readBlocks]);
          cloudUser.readBlocks = [...merged];
        }
        if (cloudUser.seenBlocks) {
          const merged = new Set([...(localUser.seenBlocks || []), ...cloudUser.seenBlocks]);
          cloudUser.seenBlocks = [...merged];
        }
        if (cloudUser.savedBlocks) {
          const merged = new Set([...(localUser.savedBlocks || []), ...cloudUser.savedBlocks]);
          cloudUser.savedBlocks = [...merged];
        }
        // Keep higher XP
        cloudUser.xp = Math.max(cloudUser.xp || 0, localUser.xp || 0);
        cloudUser.level = Math.max(cloudUser.level || 1, localUser.level || 1);
        // Merge achievements (union by id)
        const achMap = new Map();
        (localUser.achievements || []).forEach(a => achMap.set(a.id, a));
        (cloudUser.achievements || []).forEach(a => achMap.set(a.id, a));
        cloudUser.achievements = [...achMap.values()];
        cloudData['pbook-user'] = JSON.stringify(cloudUser);
      } catch(e) {}
      // Merge notes (union by blockId, cloud notes added to local)
      try {
        const localNotes = JSON.parse(localStorage.getItem('pbook-notes') || '{}');
        const cloudNotes = JSON.parse(cloudData['pbook-notes'] || '{}');
        for (const [blockId, val] of Object.entries(cloudNotes)) {
          if (!localNotes[blockId]) localNotes[blockId] = val;
          else if (Array.isArray(val) && Array.isArray(localNotes[blockId])) {
            // Merge by timestamp dedup
            const existing = new Set(localNotes[blockId].map(n => n.ts));
            val.forEach(n => { if (!existing.has(n.ts)) localNotes[blockId].push(n); });
          }
        }
        cloudData['pbook-notes'] = JSON.stringify(localNotes);
      } catch(e) {}

      this._restoreProfileData(cloudData);
    }

    // Switch Recombee identity: merge anonymous → account user
    const accountUid = 'acct-' + email.toLowerCase().trim().replace(/[^a-z0-9]/g, '-');
    await this.rc.switchUser(accountUid);
    this._syncUserToRecombee();

    this._lastSyncTime = Date.now();
    this.showXPToast(`Welcome back, ${result.displayName || 'reader'}!`, 'info');
    this._refreshAfterAuth();
  }

  async syncProfile() {
    const auth = this._getAuth();
    if (!auth) return;
    const btn = document.getElementById('syncBtn');
    if (btn) btn.textContent = 'Syncing...';

    const result = await this._authRequest({
      action: 'save',
      email: auth.email,
      token: auth.token,
      profileData: this._collectProfileData(),
    });

    if (result.error) {
      this.showXPToast(result.error, 'info');
      if (btn) btn.textContent = 'Sync now';
      // Don't auto-logout on sync errors
      return;
    }
    this._lastSyncTime = Date.now();
    if (btn) { btn.textContent = 'Synced!'; setTimeout(() => { if (btn) btn.textContent = 'Sync now'; }, 2000); }
  }

  logout() {
    this._setAuth(null);
    this._lastSyncTime = null;
    this.renderProfile();
  }

  // ===== LINEAR DFS NAVIGATION =====
  // linearNav, DFS order removed — navigation is now per-block

  // ===== CHAT (full view) =====
  initChatView() {
    const input = document.getElementById('chatInputFull');
    if (input) input.focus();
  }

  sendFullChat() {
    const input = document.getElementById('chatInputFull');
    const msg = input?.value?.trim();
    if (!msg) return;
    input.value = '';
    // Remove suggestion buttons if present
    document.querySelector('.tutor-suggestions')?.remove();
    const messages = document.getElementById('chatMessagesFull');
    if (!messages) return;
    messages.innerHTML += `<div class="chat-msg user">${this.escHtml(msg)}</div>`;
    // Show typing indicator
    const typing = document.getElementById('tutorTyping');
    if (typing) typing.style.display = 'flex';
    messages.scrollTop = messages.scrollHeight;
    // Simulate thinking delay
    setTimeout(() => {
      if (typing) typing.style.display = 'none';
      const response = this.generateChatResponse(msg);
      messages.innerHTML += `<div class="chat-msg bot">${response}</div>`;
      messages.scrollTop = messages.scrollHeight;
    }, 600 + Math.random() * 400);
  }

  // ===== GLOSSARY / TOPICS =====
  // ===== MISSIONS =====
  getMissions() {
    return [
      {
        id: 'youtube', title: 'How Does YouTube Know?', icon: '\u{1F3AC}',
        difficulty: 'Beginner',
        story: 'Your friend asks: "How does YouTube always know what I want to watch?" Can you figure out the answer and explain it?',
        goal: 'Explain how recommendations work to a friend',
        reward: { title: 'Algorithm Explainer', xp: 20 },
        core: ['ch1-noticed', 'ch1-everywhere', 'ch1-not-magic', 'ch1-three-jobs', 'ch2-footprints', 'ch2-clues'],
        intros: [
          "Let's start with something you already know. Have you ever noticed that YouTube seems to read your mind?",
          "Recommendations aren't just on YouTube. Let's see how many you can spot in everyday apps.",
          "So how does it actually work? Spoiler: it's not magic. It's pattern detection.",
          "Every recommender has three jobs. Can you guess what they are before reading?",
          "Now let's look at it from YOUR side. What clues are you leaving behind?",
          "These clues come in different flavors. Understanding them is key to understanding the whole system."
        ],
        boss: { q: 'Your friend asks: "So how DOES YouTube know what I want to watch?" Explain it in one paragraph.', hints: ['patterns', 'clicks', 'data', 'similar'] },
        branches: {
          explorer: { label: 'See it in action', blocks: ['ch2-track-d-exp', 'ch1-ws-match'] },
          creator: { label: 'Try it yourself', blocks: ['ch2-privacy-d-create'] },
          thinker: { label: 'Understand patterns', blocks: ['ch1-patterns-d-think'] }
        }
      },
      {
        id: 'detective', title: 'The Data Detective', icon: '\u{1F575}',
        difficulty: 'Beginner',
        story: 'Your recommendations are terrible — Peppa Pig keeps showing up because your sibling used your account. Time to investigate what data the algorithm actually uses.',
        goal: 'Understand what data apps collect and how signals work',
        reward: { title: 'Data Detective', xp: 20 },
        core: ['ch2-footprints', 'ch2-clues', 'ch2-guess-signal', 'ch2-myth', 'ch2-privacy'],
        intros: [
          "To fix bad recommendations, first understand what data you're leaving behind.",
          "Not all data is equal. Some clues are powerful, others are noise.",
          "Can you tell a strong signal from a weak one? This is what separates good detectives from bad ones.",
          "Before we go further, let's bust some myths. Is your phone REALLY listening?",
          "Now the big question: whose data is it anyway? And what can you do about it?"
        ],
        boss: { q: 'You see Peppa Pig in your recommendations. As a Data Detective, explain: why is it there, and what would you do to fix it?', hints: ['sibling', 'signals', 'history', 'profile'] },
        branches: {
          explorer: { label: 'Investigate your data', blocks: ['ch2-track-d-exp', 'ch2-ws-detective'] },
          creator: { label: 'Run an experiment', blocks: ['ch2-privacy-d-create'] },
          thinker: { label: 'Think about privacy', blocks: ['ch2-myth'] }
        }
      },
      {
        id: 'builder', title: 'Build a Recommender', icon: '\u{1F527}',
        difficulty: 'Intermediate',
        story: 'Your class wants a movie recommender for Friday movie night. You volunteer to build one from scratch. Can you pull it off?',
        goal: 'Build a working recommendation system step by step',
        reward: { title: 'Recommendation Engineer', xp: 30 },
        core: ['ch5-start', 'ch5-collect', 'ch3-friends', 'ch5-similar', 'ch5-recommend', 'ch5-improve'],
        intros: [
          "You said you'd build a recommender. No backing out now! Let's see what you need.",
          "Step 1: every recommender needs DATA. Time to survey your classmates.",
          "The trick is finding people with matching taste. This is called collaborative filtering.",
          "Now you need a way to MEASURE how similar two people are. Sounds hard? It's not!",
          "You have the data. You found similar people. Now make actual predictions!",
          "Your system works but... it's not great. Let's make it smarter."
        ],
        boss: { q: 'Your class tested the recommender. Someone complains: "It recommended me a movie I hate!" What went wrong, and how would you improve it?', hints: ['similar', 'data', 'diversity', 'cold start'] },
        branches: {
          creator: { label: 'Build it for real', blocks: ['ch5-spread-d-create', 'ch5-code-d-create', 'ch5-debug'] },
          thinker: { label: 'Understand the math', blocks: ['ch5-math-d-think', 'ch5-real-numbers'] },
          explorer: { label: 'See CF in action', blocks: ['ch3-cf-d-exp'] }
        }
      },
      {
        id: 'bubble', title: 'Pop the Bubble', icon: '\u{1FAE7}',
        difficulty: 'Intermediate',
        story: 'You notice your news feed only shows one type of content. Your friend sees completely different things. Are you both trapped in filter bubbles?',
        goal: 'Understand filter bubbles, echo chambers, and fairness',
        reward: { title: 'Bubble Buster', xp: 25 },
        core: ['ch4-bubbles', 'ch4-fairness', 'ch4-testing', 'ch3-popular', 'ch3-popular-sidebar'],
        intros: [
          "Something feels off. Your feed only shows gaming videos. Your friend only sees cooking. Why?",
          "Bubbles are one thing. But is the system actually FAIR to everyone?",
          "How do companies even know if their recommendations are good? Science!",
          "Let's look at the simplest recommendation: just show what's popular. What could go wrong?",
          "The popularity trap is real. Popular things get MORE popular. Is that fair?"
        ],
        boss: { q: 'A new video app asks you to design their recommendation system. How would you prevent filter bubbles while still showing relevant content?', hints: ['diversity', 'explore', 'bubble', 'balance'] },
        branches: {
          creator: { label: 'Pop your bubble', blocks: ['ch4-experiment'] },
          thinker: { label: 'Think deeply', blocks: ['ch4-echo-d-think', 'ch4-unfair-game'] },
          explorer: { label: 'Run an A/B test', blocks: ['ch4-ab-d-exp'] }
        }
      },
      {
        id: 'control', title: 'Take Back Control', icon: '\u{1F6E1}',
        difficulty: 'Advanced',
        story: 'Apps know more about you than your best friend. They track you across websites, guess your age, and use tricks to keep you scrolling. Time to fight back.',
        goal: 'Digital literacy — understand privacy, manipulation, and your rights',
        reward: { title: 'Digital Citizen', xp: 25 },
        core: ['ch6-who-decides', 'ch6-addictive', 'ch6-privacy-real', 'ch6-ai-future'],
        intros: [
          "When you open TikTok, who chose what's on your screen? The answer might surprise you.",
          "Infinite scroll. Autoplay. 'One more video.' These aren't accidents.",
          "Let's get specific: what do apps ACTUALLY know about you?",
          "You've seen the problems. Now let's talk about solutions and the future."
        ],
        boss: { q: 'Your younger cousin (age 8) is getting addicted to TikTok. What 3 specific things would you tell them about how the algorithm works, and what should they do?', hints: ['autoplay', 'algorithm', 'choice', 'control', 'data'] },
        branches: {
          explorer: { label: 'Check your data', blocks: ['ch6-data-d-exp', 'ch6-age-sidebar'] },
          creator: { label: 'Take control now', blocks: ['ch6-control-d-create'] },
          thinker: { label: 'The big questions', blocks: ['ch6-hard-d-think', 'ch6-law-sidebar'] }
        }
      },
      {
        id: 'creator-boost', title: 'Get Your Content Recommended', icon: '\u{1F4F1}',
        difficulty: 'Intermediate',
        story: "You just made an amazing video / drawing / song / game. But nobody sees it — the algorithm doesn't know it exists. Can you learn to speak the algorithm's language and get your content discovered?",
        goal: 'Understand how to make YOUR content visible to recommendation algorithms',
        reward: { title: 'Algorithm Whisperer', xp: 30 },
        core: ['ch5-get-recommended', 'ch5-seo-algorithms', 'ch3-pipeline', 'ch3-search-recs', 'ch3-popular'],
        intros: [
          "You know how algorithms pick content for viewers. Now flip it — how do you make them pick YOURS?",
          "Search and recommendations are merging. Mastering discoverability is a superpower.",
          "To beat the system, you need to understand the system. How does the pipeline actually work?",
          "When you search on YouTube, results are personalized. How do you show up for the RIGHT people?",
          "Everyone starts with popularity. But how do you escape the popularity trap as a new creator?"
        ],
        boss: { q: "You just uploaded a video about building a Minecraft castle. Describe 5 specific things you would do to maximize the chance the algorithm recommends it to the right audience — on YouTube AND TikTok.", hints: ['thumbnail', 'title', 'hook', 'watch time', 'trending', 'hashtag', 'first seconds', 'consistency'] },
        branches: {
          explorer: { label: 'Study the pipeline', blocks: ['ch3-pipeline-d-exp'] },
          creator: { label: 'Build & optimize', blocks: ['ch5-spread-d-create'] },
          thinker: { label: 'Ethics of gaming', blocks: ['ch4-objectives'] }
        }
      },
      {
        id: 'master', title: 'Recommendation Master', icon: '\u{1F451}',
        difficulty: 'Capstone',
        story: "You've learned the pieces. Now put it all together. Can you explain the FULL journey of a recommendation — from the moment you click to the moment a new suggestion appears?",
        goal: 'Deep mastery — understand the full pipeline, methods, and tradeoffs',
        reward: { title: 'Recommendation Master', xp: 40 },
        prerequisite: 2,
        core: ['ch3-pipeline', 'ch3-content', 'ch3-friends', 'ch4-testing', 'ch5-improve', 'ch6-ai-future'],
        intros: [
          "Welcome to the capstone. Real systems use EVERYTHING together in a pipeline.",
          "One approach: look at the ITEM itself — its features, tags, description.",
          "Another approach: look at the PEOPLE — find taste twins using collaborative filtering.",
          "How do you know if the system works? You test it. Rigorously.",
          "A working system isn't a finished system. There's always room to improve.",
          "Finally: what does all of this mean for the future — and for YOU?"
        ],
        boss: { q: 'Explain the full journey of a YouTube recommendation: from the moment you click a video to when new suggestions appear. Include at least 3 methods the system uses.', hints: ['pipeline', 'collaborative', 'content-based', 'candidate', 'ranking', 'diversity'] },
        branches: {
          explorer: { label: 'Trace a real rec', blocks: ['ch3-pipeline-d-exp'] },
          creator: { label: 'Build CF system', blocks: ['ch3-cf-d-create'] },
          thinker: { label: 'Compare methods', blocks: ['ch3-compare-d-think', 'ch3-speed'] }
        }
      }
    ];
  }

  _getMissionBlocks(mission) {
    const branch = this.user.missionBranches?.[mission.id];
    const branchBlocks = branch && mission.branches[branch] ? mission.branches[branch].blocks : [];
    return [...mission.core, ...branchBlocks];
  }

  _getMissionProgress(mission) {
    const read = mission.core.filter(id => this.user.readBlocks.has(id)).length;
    return { read, total: mission.core.length, pct: Math.round((read / Math.max(mission.core.length, 1)) * 100) };
  }


  _isMissionLocked(mission) {
    if (!mission.prerequisite) return false;
    const completed = (this.user.completedMissions || []).length;
    return completed < mission.prerequisite;
  }

  renderMissions() {
    const el = document.getElementById('glossaryContent');
    const missions = this.getMissions();
    const completed = new Set(this.user.completedMissions || []);

    let html = '<div class="missions-inner">';
    html += '<div class="missions-head"><h2>Missions</h2><p>Choose your adventure. Each mission tells a story and teaches you something new.</p></div>';

    missions.forEach(m => {
      const prog = this._getMissionProgress(m);
      const isComplete = completed.has(m.id);
      const isLocked = this._isMissionLocked(m);
      const isActive = prog.read > 0 && !isComplete;
      const diffColors = { Beginner: '#10B981', Intermediate: '#F59E0B', Advanced: '#EF4444', Capstone: '#8B5CF6' };

      html += `<div class="mission-card ${isComplete ? 'mission-complete' : ''} ${isLocked ? 'mission-locked' : ''} ${isActive ? 'mission-active' : ''}" onclick="${isLocked ? '' : `app.showMission('${m.id}')`}">
        <div class="mission-icon">${isLocked ? '\u{1F512}' : m.icon}</div>
        <div class="mission-info">
          <div class="mission-title-row">
            <span class="mission-title">${m.title}</span>
            <span class="mission-diff" style="background:${diffColors[m.difficulty]}">${m.difficulty}</span>
          </div>
          <div class="mission-story">${isLocked ? `Complete ${m.prerequisite} missions to unlock` : m.story.substring(0, 80) + '...'}</div>
          <div class="mission-progress-dots">
            ${m.core.map((id, i) => {
              const read = isComplete || this.user.readBlocks.has(id);
              return `<span class="mission-dot ${read ? 'done' : i === prog.read ? 'current' : ''}"></span>`;
            }).join('')}
          </div>
          <div class="mission-meta">
            <span class="mission-reward-preview">${m.reward.title} +${m.reward.xp}XP</span>
            ${isComplete ? '<span class="mission-complete-badge">\u2713 Complete</span>' : `<span>${prog.read}/${m.core.length}</span>`}
          </div>
        </div>
      </div>`;
    });

    html += '</div>';
    el.innerHTML = html;
  }

  showMission(missionId) {
    const missions = this.getMissions();
    const m = missions.find(x => x.id === missionId);
    if (!m) return;
    if (this.currentView !== 'glossary') this.switchView('glossary');

    const el = document.getElementById('glossaryContent');
    const prog = this._getMissionProgress(m);
    const isComplete = (this.user.completedMissions || []).includes(m.id);
    const branch = this.user.missionBranches?.[m.id];
    const allBlocks = this._getMissionBlocks(m);
    const coreComplete = m.core.every(id => this.user.readBlocks.has(id));

    let html = '<div class="missions-inner">';
    html += `<button class="btn-ghost" onclick="app.renderMissions()" style="margin-bottom:.5em">&larr; All missions</button>`;
    html += `<div class="mission-detail-header">
      <span class="mission-detail-icon">${m.icon}</span>
      <div>
        <h2 class="mission-detail-title">${m.title}</h2>
        <p class="mission-detail-goal">${m.goal}</p>
      </div>
      <button class="act-btn share-btn" onclick="app.shareMission('${m.id}')" title="Share this mission" style="margin-left:auto;font-size:1rem">&#128279;</button>
    </div>`;
    html += `<div class="mission-detail-story">${m.story}</div>`;

    // Start/Continue wizard button
    if (!isComplete) {
      const wizardLabel = prog.read === 0 ? 'Start mission' : 'Continue mission';
      html += `<div style="text-align:center;margin-bottom:1em"><button class="mission-complete-btn" onclick="app.startMissionWizard('${m.id}')">${wizardLabel} &rarr;</button></div>`;
    }

    // Progress overview — show core dots + optional branch dots
    const coreRead = m.core.filter(id => this.user.readBlocks.has(id)).length;
    html += `<div class="mission-detail-progress">
      <div class="mission-progress-dots" style="justify-content:center">
        ${m.core.map((id, i) => {
          const read = isComplete || this.user.readBlocks.has(id);
          return `<span class="mission-dot ${read ? 'done' : ''}" title="${this.findBlock(id)?.meta?.title || id}"></span>`;
        }).join('')}
        ${branch ? m.branches[branch].blocks.map(id => {
          const read = this.user.readBlocks.has(id);
          return `<span class="mission-dot branch-dot ${read ? 'done' : ''}" title="${this.findBlock(id)?.meta?.title || id}"></span>`;
        }).join('') : ''}
      </div>
      <div style="text-align:center;font-size:.75rem;color:var(--text-3);margin-top:.3em">${coreRead}/${m.core.length} core steps${branch ? ` + bonus ${m.branches[branch].blocks.filter(id => this.user.readBlocks.has(id)).length}/${m.branches[branch].blocks.length}` : ''}</div>
    </div>`;

    // Step list — core blocks
    html += '<div class="mission-steps">';
    html += '<div class="mission-steps-label">Your journey</div>';
    m.core.forEach((id, i) => {
      const block = this.findBlock(id);
      const isRead = this.user.readBlocks.has(id);
      const title = block?.meta?.title || id;
      const ch = block?.meta?._chapterNum || '?';
      html += `<div class="mission-step ${isRead ? 'step-done' : ''}" onclick="app.openBlock('${id}')">
        <div class="step-marker">${isRead ? '\u2713' : i + 1}</div>
        <div class="step-content">
          <div class="step-title">${title}</div>
          <div class="step-meta">Chapter ${ch} &middot; ${block?.meta?.readingTime || 3} min</div>
        </div>
      </div>`;
    });

    // Branch point
    if (!branch) {
      html += `<div class="mission-branch-point">
        <div class="branch-label">Choose your path</div>
        <div class="branch-desc">The story branches here. Pick your style — the book adapts to you!</div>
        <div class="branch-options">`;
      Object.entries(m.branches).forEach(([voice, b]) => {
        const vc = CONFIG.voices[voice] || {};
        html += `<button class="branch-option ${voice}" onclick="app.pickBranch('${m.id}','${voice}')">
          <span class="branch-icon">${vc.icon || ''}</span>
          <span class="branch-name">${vc.label || voice}</span>
          <span class="branch-desc-text">${b.label}</span>
          <span class="branch-count">+${b.blocks.length} sections</span>
        </button>`;
      });
      html += '</div></div>';
    } else {
      // Show chosen branch blocks
      const b = m.branches[branch];
      const vc = CONFIG.voices[branch] || {};
      html += `<div class="mission-branch-chosen">
        <div class="branch-label">${vc.icon || ''} ${vc.label || branch} path <button class="btn-ghost" style="font-size:.7rem" onclick="app.pickBranch('${m.id}',null)">change</button></div>
      </div>`;
      b.blocks.forEach((id, i) => {
        const block = this.findBlock(id);
        const isRead = this.user.readBlocks.has(id);
        const title = block?.meta?.title || id;
        html += `<div class="mission-step ${isRead ? 'step-done' : ''} step-branch" onclick="app.openBlock('${id}')">
          <div class="step-marker">${isRead ? '\u2713' : '\u2022'}</div>
          <div class="step-content">
            <div class="step-title">${title}</div>
            <div class="step-meta">${vc.label} path &middot; ${block?.meta?.readingTime || 3} min</div>
          </div>
        </div>`;
      });
    }

    html += '</div>';

    // Complete button or reward
    if (isComplete) {
      html += `<div class="mission-reward-earned">
        <div class="reward-icon">\u{1F3C6}</div>
        <div class="reward-text">Mission complete! You earned: <b>${m.reward.title}</b> +${m.reward.xp} XP</div>
      </div>`;
    } else if (coreComplete) {
      html += `<div class="mission-complete-action">
        <button class="mission-complete-btn" onclick="app.completeMission('${m.id}')">Complete mission &rarr;</button>
      </div>`;
    }

    html += '</div>';
    el.innerHTML = html;
  }

  pickBranch(missionId, voice) {
    if (!this.user.missionBranches) this.user.missionBranches = {};
    if (voice === null) { delete this.user.missionBranches[missionId]; }
    else { this.user.missionBranches[missionId] = voice; }
    this.user.save();
    this.showMission(missionId);
  }

  completeMission(missionId) {
    const missions = this.getMissions();
    const m = missions.find(x => x.id === missionId);
    if (!m) return;
    if (!this.user.completedMissions) this.user.completedMissions = [];
    if (this.user.completedMissions.includes(missionId)) return;

    this.user.completedMissions.push(missionId);
    if (!this.user.missionTitles) this.user.missionTitles = [];
    this.user.missionTitles.push(m.reward.title);
    this.user.addXP(m.reward.xp);
    this.user.checkAchievements();
    this.user.save();

    this.showXPToast(`\u{1F3C6} ${m.reward.title}! +${m.reward.xp} XP`, 'achievement');
    this.checkGamificationEvents();
    this.showMission(missionId);
  }

  // ===== MISSION WIZARD MODE =====
  startMissionWizard(missionId) {
    const missions = this.getMissions();
    const m = missions.find(x => x.id === missionId);
    if (!m) return;
    this._wizardMission = m;
    this._wizardStep = 0;
    // Find first unread core block
    const firstUnread = m.core.findIndex(id => !this.user.readBlocks.has(id));
    if (firstUnread >= 0) this._wizardStep = firstUnread;
    this._renderWizardStep();
  }

  _renderWizardStep() {
    const m = this._wizardMission;
    if (!m) return;
    const step = this._wizardStep;
    const blocks = m.core;

    // Past the last core block → show boss quiz
    if (step >= blocks.length) {
      this._renderBossQuiz();
      return;
    }

    const blockId = blocks[step];
    const block = this.findBlock(blockId);
    const intro = m.intros?.[step] || '';
    const isRead = this.user.readBlocks.has(blockId);

    // Render wizard overlay in the glossary view
    const el = document.getElementById('glossaryContent');
    let html = '<div class="wizard-container">';

    // Progress bar
    html += `<div class="wizard-progress">
      <div class="wizard-progress-fill" style="width:${Math.round(((step) / blocks.length) * 100)}%"></div>
    </div>
    <div class="wizard-progress-label">${m.icon} ${m.title} &middot; Step ${step + 1} of ${blocks.length}</div>`;

    // Story intro
    if (intro) {
      html += `<div class="wizard-intro">${intro}</div>`;
    }

    // Block content preview
    html += `<div class="wizard-block-card" onclick="app._pendingMissionIntro='${(intro||'').replace(/'/g,"\\'")}';app.openBlock('${blockId}')">
      <div class="wizard-block-title">${block?.meta?.title || blockId}</div>
      <div class="wizard-block-teaser">${block?.meta?.teaser || ''}</div>
      <div class="wizard-block-meta">Chapter ${block?.meta?._chapterNum || '?'} &middot; ${block?.meta?.readingTime || 3} min read</div>
      <button class="wizard-read-btn">${isRead ? '\u2713 Read again' : 'Read this section'} &rarr;</button>
    </div>`;

    // Navigation
    html += `<div class="wizard-nav">
      ${step > 0 ? `<button class="wizard-nav-btn" onclick="app._wizardStep=${step - 1};app._renderWizardStep()">&larr; Previous</button>` : '<span></span>'}
      ${isRead ? `<button class="wizard-nav-btn wizard-nav-next" onclick="app._wizardStep=${step + 1};app._renderWizardStep()">Next &rarr;</button>` : `<button class="wizard-nav-btn" disabled style="opacity:.4">Read to continue</button>`}
    </div>`;

    html += '</div>';
    el.innerHTML = html;
    if (this.currentView !== 'glossary') this.switchView('glossary');
    window.scrollTo(0, 0);
  }

  _renderBossQuiz() {
    const m = this._wizardMission;
    if (!m || !m.boss) { this.completeMission(m.id); return; }

    const el = document.getElementById('glossaryContent');
    let html = '<div class="wizard-container">';

    html += `<div class="wizard-progress">
      <div class="wizard-progress-fill" style="width:100%"></div>
    </div>
    <div class="wizard-progress-label">${m.icon} ${m.title} &middot; Final Challenge!</div>`;

    html += `<div class="boss-card">
      <div class="boss-icon">\u{1F409}</div>
      <h3 class="boss-title">Final Boss: Prove You've Learned!</h3>
      <div class="boss-question">${m.boss.q}</div>
      <textarea class="boss-answer" id="bossAnswer" placeholder="Type your answer here..." rows="4"></textarea>
      <div class="boss-hint" id="bossHint" style="display:none"></div>
      <div class="boss-actions">
        <button class="boss-submit" onclick="app._checkBossAnswer('${m.id}')">Check my answer</button>
      </div>
    </div>`;

    html += '</div>';
    el.innerHTML = html;
    window.scrollTo(0, 0);
  }

  _checkBossAnswer(missionId) {
    const m = this._wizardMission;
    if (!m) return;
    const answer = document.getElementById('bossAnswer')?.value?.toLowerCase() || '';
    const hints = m.boss.hints || [];
    const found = hints.filter(h => answer.includes(h));
    const score = found.length / Math.max(hints.length, 1);

    const hintEl = document.getElementById('bossHint');
    if (!hintEl) return;

    if (score >= 0.5 || answer.length > 80) {
      // Pass! Complete the mission
      hintEl.style.display = 'block';
      hintEl.className = 'boss-hint boss-pass';
      hintEl.innerHTML = `<b>Awesome!</b> You mentioned ${found.length} key concepts. You clearly understand this topic!`;
      setTimeout(() => this.completeMission(missionId), 1500);
    } else if (answer.length < 20) {
      hintEl.style.display = 'block';
      hintEl.className = 'boss-hint boss-retry';
      hintEl.innerHTML = 'Write a bit more! Try to explain in at least a few sentences.';
    } else {
      const missing = hints.filter(h => !answer.includes(h)).slice(0, 2);
      hintEl.style.display = 'block';
      hintEl.className = 'boss-hint boss-retry';
      hintEl.innerHTML = `Good start! But try to also mention: <b>${missing.join('</b> and <b>')}</b>. Go back and re-read if you need to!`;
      // Add a "go back" button
      hintEl.innerHTML += `<br><button class="wizard-nav-btn" style="margin-top:.4em" onclick="app._wizardStep=0;app._renderWizardStep()">Review the steps</button>`;
    }
  }

  showTopic(topic) {
    // Redirect topic clicks to missions view
    this.switchView('glossary');
  }



  generateChatResponse(query, targetEl) {
    const context = {
      allBlocks: this.allBlocks,
      topicIndex: this.topicIndex,
      currentBlockId: this.user.currentBlock,
      currentChapterId: this.chapters[this.user.currentChapter]?.id,
      userProfile: this.user
    };

    const result = this.tutor.generateResponse(query, context);

    // Store in conversation
    const blockId = this.user.currentBlock || null;
    const chapterId = context.currentChapterId || null;
    const conv = this.convManager.getOrCreateConversation(blockId, chapterId);
    this._activeConvId = conv.id;
    this.convManager.addMessage(conv.id, 'user', query);
    this.convManager.addMessage(conv.id, 'tutor', result.text, { confidence: result.confidence });

    // Build response with follow-up and escalation
    let html = result.text;
    if (result.followUp) {
      html += `<br><br><i>${result.followUp}</i>`;
    }
    if (result.canEscalate) {
      html += `<br><br><button class="tutor-escalate-btn" onclick="app.escalateToAuthor()">Ask the author instead</button>`;
    }
    return html;
  }

  escalateToAuthor() {
    if (!this._activeConvId) return;
    const conv = this.convManager.conversations.find(c => c.id === this._activeConvId);
    const lastUserMsg = conv?.messages?.filter(m => m.role === 'user').pop();
    if (!lastUserMsg) return;

    this.convManager.escalateToAuthor(
      this._activeConvId,
      lastUserMsg.text,
      this.user.currentBlock,
      this.user
    );

    // Show confirmation in chat
    const msgHtml = '<div class="chat-msg system">Your question has been sent to Pavel (the author). He reads every message! In the meantime, try exploring related sections in the book.</div>';
    const chatEl = document.getElementById('chatMessagesFull') || document.getElementById('chatMessages');
    if (chatEl) chatEl.insertAdjacentHTML('beforeend', msgHtml);
  }

  askAboutBlock(blockId) {
    const block = this.findBlock(blockId);
    if (!block) return;
    this.user.currentBlock = blockId;
    this.user.save();
    this.tutor.resetConversation();
    this.switchView('chat');
    // Pre-seed with suggested questions
    const questions = this.tutor.getSuggestedQuestions(block);
    const chatEl = document.getElementById('chatMessagesFull');
    if (chatEl) {
      chatEl.innerHTML = `<div class="chat-msg bot">Pavel wrote a lot about <b>${block.meta.title}</b>. What would you like to know? I can explain it, find related sections, or go deeper!</div>`;
      if (questions.length) {
        let sugHtml = '<div class="tutor-suggestions">';
        questions.forEach(q => {
          sugHtml += `<button class="tutor-suggest-btn" onclick="app.askSuggested(this,'${this.escHtml(q)}')">${q}</button>`;
        });
        sugHtml += '</div>';
        chatEl.insertAdjacentHTML('beforeend', sugHtml);
      }
    }
    document.getElementById('chatInputFull')?.focus();
  }

  askSuggested(btn, question) {
    // Remove suggestions
    btn.closest('.tutor-suggestions')?.remove();
    // Send as if user typed it
    const input = document.getElementById('chatInputFull');
    if (input) { input.value = question; this.sendFullChat(); }
  }

  // ===== SEARCH =====
  openSearch() {
    document.getElementById('searchOverlay').classList.add('open');
    document.getElementById('searchInput').focus();
  }

  closeSearch() {
    document.getElementById('searchOverlay').classList.remove('open');
    document.getElementById('searchInput').value = '';
  }

  async onSearch(query) {
    const el = document.getElementById('searchResults');
    if (!query || query.length < 2) { el.innerHTML = '<div class="search-empty">Type to search across all content...</div>'; return; }
    const results = await this.rc.searchItems(query, 15, null, 'search');
    if (!results?.recomms?.length) { el.innerHTML = '<div class="search-empty">No results found.</div>'; return; }
    el.innerHTML = results.recomms.map(r => {
      const b = this.findBlock(r.id);
      const meta = b?.meta || r.values || {};
      const badge = meta.voice && meta.voice !== 'universal' ? `<span class="card-badge ${meta.voice}">${CONFIG.voices[meta.voice]?.label || meta.voice}</span>` : '';
      return `<div class="card" style="margin-bottom:.5em" onclick="app.openBlock('${r.id}','search');app.closeSearch()"><div class="card-chapter">${meta._chapterTitle || ''}</div><div class="card-title">${meta.title || r.id}</div><div class="card-meta">${badge}<span class="card-time">${meta.readingTime || 3} min</span></div></div>`;
    }).join('');
  }

  // ===== INTERACTIONS =====

  answerQ(el, voice, qId) {
    el.closest('.q-opts').querySelectorAll('.q-opt').forEach(o => o.classList.remove('selected'));
    el.classList.add('selected');
    this.rc.sendRating(qId, 1);
    if (voice && voice !== 'universal') {
      this.user.setVoice(voice);
      this.user.voiceScores[voice] = Math.max(this.user.voiceScores[voice] || 0, 1);
      this.user.save();
      this.updateVoiceBadge();
    }

    const qBlock = el.closest('.q-block');
    let recsDiv = qBlock.querySelector('.q-recs');
    if (!recsDiv) { recsDiv = document.createElement('div'); recsDiv.className = 'q-recs fade-up'; qBlock.appendChild(recsDiv); }

    // Generate personalized feedback based on the answer
    const answerText = el.textContent.trim();
    const letter = el.querySelector('.q-letter')?.textContent?.trim() || '';
    const feedback = this._generateAnswerFeedback(qId, letter, voice, answerText);

    // Find matching recommendations
    const vc = CONFIG.voices[voice] || {};
    const voiceFilter = voice !== 'universal' ? voice : null;
    let recs = [];
    if (voiceFilter) {
      const voiceDepths = this.allBlocks.filter(b => b.meta.voice === voiceFilter && b.meta.type === 'depth' && !this.user.readBlocks.has(b.meta.id));
      const unreadSpines = this.allBlocks.filter(b => b.meta.type === 'spine' && !this.user.readBlocks.has(b.meta.id));
      recs = [...voiceDepths.slice(0, 3), ...unreadSpines.slice(0, 2)].slice(0, 4);
    } else {
      recs = this.allBlocks.filter(b => b.meta.type === 'spine' && !this.user.readBlocks.has(b.meta.id)).slice(0, 4);
    }

    let html = `<div class="q-feedback fade-up">${feedback}</div>`;
    if (recs.length) {
      html += `<div class="q-recs-title">Here's what to read next${vc.label ? ' (' + vc.label + ' path)' : ''}:</div>`;
      html += recs.map(b => `<div class="q-rec-item">${this.cardHtml(b.meta)}</div>`).join('');
    }
    recsDiv.innerHTML = html;
    recsDiv.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  _generateAnswerFeedback(qId, letter, voice, text) {
    // Question-specific feedback
    const feedbacks = {
      'ch1-q1': {
        A: "Awesome choice! You're an Explorer! You'll love seeing how YouTube's algorithm actually decides what to show you — it's like peeking behind a magic curtain. Let's dig into the mechanics!",
        B: "A Creator at heart! Building things is the BEST way to learn. By the end of this book, you'll have made your own recommendation system. How cool is that?",
        C: "Great thinking! Understanding WHY things go wrong helps us make them better. You'll discover some surprising reasons why recommendations mess up — and what we can do about it.",
        D: "You want it all — love it! You'll get to explore, build, AND think deeply. Every chapter has something for everyone."
      },
      'ch3-q1': {
        A: "Collaborative filtering is fascinating! It's basically the idea that birds of a feather flock together. If you and someone else both love the same movies, you'll probably agree on new ones too!",
        B: "Smart thinking! Content-based filtering is super logical — if you liked a video about building Minecraft castles, you'll probably like other building videos. Simple but powerful!",
        C: "You're thinking like a real engineer! The best systems in the world (YouTube, Spotify, Netflix) all use hybrid approaches. Why pick one when you can use them all?",
        D: "Sometimes the simplest solution is the best starting point! Showing what's popular is how most apps begin. Then they add smarter methods over time."
      },
      'ch4-q1': {
        A: "Accuracy matters — nobody likes bad recommendations! But here's a fun twist: sometimes the MOST accurate system only shows you things you already know you like. Is that really the best?",
        B: "You care about fairness — that's awesome! Imagine being a new YouTuber whose amazing videos never get recommended just because you're not famous yet. Fairness means giving everyone a chance.",
        C: "Discovery is what makes recommendations MAGICAL! The best recommendation isn't something you already wanted — it's something you didn't know existed but absolutely love.",
        D: "That's the right answer! The best recommendation systems balance all three. It's tricky, but that's what makes it such an interesting problem to solve."
      },
      'ch5-q1': {
        A: "A Minecraft server recommender — YES! Imagine: it knows you like survival mode with friends, building medieval stuff, and servers with <50 players. It finds your perfect match. You could totally build this!",
        B: "A music discovery engine! What if it could find genres you've never heard of based on the FEEL of music you like? Not just 'more pop' but 'here's this amazing Japanese city pop that has the same vibe.'",
        C: "A smart book recommender! It could track not just what books you like, but how fast you read, whether you prefer short or long chapters, and even match your mood. Libraries would love this!",
        D: "The best inventions are the ones nobody saw coming! Maybe a recommendation system for study buddies, hiking trails, science experiments, or even what to cook for dinner tonight. Dream big!"
      },
      'ch6-q1': {
        A: "That's a valid choice — you value personalization. But think about this: if the algorithm ONLY shows you what you want, how will you ever discover something new? Sometimes the best experiences come from things you didn't know you'd like.",
        B: "You want full control — respect! Some countries are actually making this a legal right. The EU's Digital Services Act lets people opt out of algorithmic recommendations entirely. You're thinking like a lawmaker!",
        C: "That's a really mature perspective. Showing diverse viewpoints is important for understanding the world. The tricky part: who decides what counts as 'diverse'? It's harder than it sounds, but it's worth trying.",
        D: "Honestly? This might be the wisest answer. These are genuinely hard questions with no perfect solutions. The fact that you recognize the complexity means you're thinking more deeply than most adults. Keep questioning!"
      }
    };

    // Look up specific feedback
    const qFeedbacks = feedbacks[qId];
    if (qFeedbacks && qFeedbacks[letter]) {
      return qFeedbacks[letter];
    }

    // Generic voice-based feedback
    const voiceFeedback = {
      explorer: "Great pick! As an Explorer, you'll love the hands-on demos and visual explanations coming up. Let's see how things work under the hood!",
      creator: "Awesome — you chose the Creator path! Get ready for projects, experiments, and building real things. Learning by doing is the best!",
      thinker: "Nice — you're a Thinker! You like understanding the WHY behind things. The deeper explanations coming up are perfect for you.",
      universal: "Great choice! You'll get a mix of everything — exploring, creating, and thinking. Let's keep going!"
    };

    return voiceFeedback[voice] || voiceFeedback.universal;
  }

  toggleLike(blockId) {
    const current = this.user.ratings.get(blockId);
    const newRating = current >= 0.7 ? 0 : 1; // toggle
    this.rc.sendRating(blockId, newRating);
    this.user.trackRating(blockId, newRating);
    if (!this.user.seenBlocks.has(blockId)) this.user.trackSeen(blockId);
    if (newRating >= 0.7 && !this.user.readBlocks.has(blockId)) this.user.trackRead(blockId);
    if (newRating >= 0.7) { this.showXPToast('+3 XP ❤️', 'xp'); this.checkGamificationEvents(); }
    // Update button visually
    const btn = document.querySelector(`.block-reactions[data-block="${blockId}"] .like-btn`);
    if (btn) {
      btn.classList.toggle('liked', newRating >= 0.7);
      btn.innerHTML = newRating >= 0.7 ? '&#10084;&#65039; <span>Liked</span>' : '&#9825; <span>Like</span>';
    }
  }


  saveBlock(blockId) {
    this.user.trackSave(blockId);
    this.rc.sendBookmark(blockId);
    if (!this.user.seenBlocks.has(blockId)) this.user.trackSeen(blockId);
    const btn = document.querySelector(`#b-${blockId} .act-btn[title="Save"]`);
    if (btn) btn.classList.add('active');
  }


  openBlock(blockId, source) {
    const block = this.findBlock(blockId);
    if (!block) return;
    const chIdx = block.meta._chapterIdx;
    const parentId = blockId;

    // Save current position to navigation history (for back button)
    if (this.currentView === 'read' && this.user.currentBlock) {
      if (!this._navHistory) this._navHistory = [];
      this._navHistory.push({ blockId: this.user.currentBlock, chIdx: this.user.currentChapter, scrollY: window.scrollY });
      if (this._navHistory.length > 20) this._navHistory.shift();
    }

    this.user.currentBlock = blockId;
    this.user.currentChapter = chIdx;
    this.user.save();
    // Update URL hash for sharing
    history.replaceState(null, '', '#' + blockId);
    // Set analytics context: where did user discover this block?
    const mode = source || (this._wizardMission ? 'mission' : this.currentView === 'home' ? 'netflix' : this.currentView === 'map' ? 'map' : this.currentView === 'read' ? 'read' : this.currentView);
    this.rc.setContext(mode, { blockId, chapter: chIdx });
    this.rc.logEvent('open_block', { mode, blockId });

    // If already viewing this chapter, just scroll
    if (this.currentView === 'read' && this._renderedChapter === chIdx) {
      this._scrollToBlock(parentId, block.meta);
      this._updateMissionBar();
      return;
    }

    this._pendingScroll = { parentId, meta: block.meta };
    this.switchView('read', true); // auto — don't log as user-initiated mode switch
    this.renderRead(chIdx);
  }

  // Show/hide mission indicator in topbar
  _updateMissionBar() {
    const container = document.getElementById('missionBarInline');
    if (!container) return;
    if (!this._f('missions')) { container.style.display = 'none'; return; }
    const m = this._wizardMission;
    if (!m) { container.style.display = 'none'; return; }

    container.style.display = 'flex';
    const step = this._wizardStep;
    container.innerHTML = `
      <button class="mission-bar-back" onclick="app._returnToWizard()" title="Next step">&#127919;</button>
      <div class="mission-bar-dots">${m.core.map((id, i) => {
        const b = this.findBlock(id);
        const title = b?.meta?.title || id;
        const cls = this.user.readBlocks.has(id) ? 'done' : i === step ? 'current' : '';
        return `<span class="mission-dot ${cls}" title="${this.escHtml(title)}" onclick="app._wizardStep=${i};app._pendingMissionIntro='${(m.intros?.[i]||'').replace(/'/g,"\\'")}';app.openBlock('${id}')" style="cursor:pointer"></span>`;
      }).join('')}</div>
    `;
  }

  _returnToWizard() {
    if (!this._wizardMission) return;
    const m = this._wizardMission;

    // Find next unread step
    let nextStep = this._wizardStep;
    const currentId = m.core[nextStep];
    if (currentId && this.user.readBlocks.has(currentId)) nextStep++;
    while (nextStep < m.core.length && this.user.readBlocks.has(m.core[nextStep])) nextStep++;
    this._wizardStep = nextStep;

    if (nextStep >= m.core.length) {
      // All core read — go to boss quiz
      this._wizardStep = m.core.length;
      this._renderBossQuiz();
      return;
    }

    // Navigate to next block and show intro banner
    const nextId = m.core[nextStep];
    const intro = m.intros?.[nextStep] || '';
    this._pendingMissionIntro = intro;
    this.openBlock(nextId);
  }

  // Show mission intro banner above the read content
  _showMissionIntro() {
    const intro = this._pendingMissionIntro;
    this._pendingMissionIntro = null;
    if (!intro) return;

    const pane = document.getElementById('readPane');
    if (!pane) return;
    // Remove old banner if exists
    pane.querySelector('.mission-intro-banner')?.remove();
    const banner = document.createElement('div');
    banner.className = 'mission-intro-banner fade-up';
    banner.innerHTML = `<span class="mission-intro-text">${this._wizardMission?.icon || ''} ${intro}</span><button class="mission-intro-close" onclick="this.parentElement.remove()">&times;</button>`;
    pane.prepend(banner);
  }

  goBack() {
    if (!this._navHistory || !this._navHistory.length) {
      // No history — go to welcome/home
      this.showWelcome();
      return;
    }
    const prev = this._navHistory.pop();
    // Don't push to history again (avoid infinite loop)
    this.user.currentBlock = prev.blockId;
    this.user.currentChapter = prev.chIdx;
    this.user.save();
    if (this._renderedChapter === prev.chIdx) {
      // Same chapter — just scroll back
      window.scrollTo(0, prev.scrollY);
    } else {
      // Different chapter — render and scroll
      this._pendingScroll = { parentId: prev.blockId, meta: this.findBlock(prev.blockId)?.meta || { id: prev.blockId } };
      this.switchView('read', true);
      this.renderRead(prev.chIdx);
    }
  }


  _scrollToBlock(parentId, meta) {
    setTimeout(() => {
      const el = document.getElementById(`b-${meta.id}`) || document.getElementById(`b-${parentId}`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 300);
  }

  goToMapChapter(idx) {
    this.switchView('map');
    // Scroll to the chapter in map after render
    setTimeout(() => {
      const chEl = document.querySelectorAll('.map-chapter')[idx];
      if (chEl) chEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 300);
  }

  goChapter(idx) {
    this.user.currentChapter = idx;
    this.user.save();
    this.switchView('read');
    this.renderRead(idx);
  }

  // ===== SETTINGS =====
  toggleSettings() {
    const drawer = document.getElementById('settingsDrawer');
    drawer.classList.toggle('open');
    if (drawer.classList.contains('open')) {
      this._renderSettingsAccount();
      this._renderSettingsThemes();
    }
  }

  _renderSettingsAccount() {
    const el = document.getElementById('settingsAccount');
    if (!el) return;
    const auth = this._getAuth();
    if (auth) {
      el.innerHTML = `<label>Account</label>
        <div class="auth-card auth-logged-in" style="margin-top:.3em">
          <div class="auth-avatar" style="width:32px;height:32px;font-size:1.1rem">${this.getLevelIcon()}</div>
          <div class="auth-info">
            <div class="auth-name" style="font-size:.8rem">${this.escHtml(auth.displayName || 'Reader')}</div>
            <div class="auth-email" style="font-size:.65rem"><span style="color:var(--product)">&#9679;</span> ${this.escHtml(auth.email)}</div>
          </div>
          <button class="auth-secondary-btn" style="font-size:.68rem;padding:.3em .5em" onclick="app._showEditAccount()">Edit</button>
          <button class="auth-logout-btn" onclick="app.logout();app._renderSettingsAccount();app.renderProfile()">Log out</button>
        </div>
        <div id="editAccountForm" style="display:none;margin-top:.4em">
          <input type="text" id="editName" class="auth-input" placeholder="Display name" value="${this.escHtml(auth.displayName || '')}" maxlength="60" style="font-size:.78rem;padding:.4em .6em">
          <input type="password" id="editPassword" class="auth-input" placeholder="New password (leave empty to keep)" maxlength="100" style="font-size:.78rem;padding:.4em .6em">
          <div class="auth-btns">
            <button class="auth-primary-btn" style="font-size:.72rem;padding:.35em" onclick="app.updateAccount()">Save changes</button>
            <button class="auth-secondary-btn" style="font-size:.72rem;padding:.35em" onclick="document.getElementById('editAccountForm').style.display='none'">Cancel</button>
          </div>
          <div id="editAccountError" class="auth-error"></div>
        </div>`;
    } else {
      const savedName = localStorage.getItem('pbook-cert-name') || '';
      el.innerHTML = `<label>Account</label>
        <div style="margin-top:.3em">
          <input type="text" id="authName" class="auth-input" placeholder="Your name" value="${this.escHtml(savedName)}" maxlength="60" style="font-size:.78rem;padding:.4em .6em">
          <input type="email" id="authEmail" class="auth-input" placeholder="Email" maxlength="120" style="font-size:.78rem;padding:.4em .6em">
          <input type="password" id="authPassword" class="auth-input" placeholder="Password (4+ chars)" maxlength="100" style="font-size:.78rem;padding:.4em .6em">
          <div class="auth-btns">
            <button class="auth-primary-btn" style="font-size:.75rem;padding:.4em" onclick="app.register()">Create account</button>
            <button class="auth-secondary-btn" style="font-size:.75rem;padding:.4em" onclick="app.login()">Log in</button>
          </div>
          <div id="authError" class="auth-error"></div>
        </div>`;
    }
  }

  _showEditAccount() {
    const form = document.getElementById('editAccountForm');
    if (form) form.style.display = form.style.display === 'none' ? 'block' : 'none';
  }

  async updateAccount() {
    const auth = this._getAuth();
    if (!auth) return;
    const name = document.getElementById('editName')?.value?.trim();
    const password = document.getElementById('editPassword')?.value;
    const errEl = document.getElementById('editAccountError');

    const body = { action: 'update', email: auth.email };
    if (name) body.displayName = name;
    if (password) {
      if (password.length < 4) { if (errEl) errEl.textContent = 'Password must be at least 4 characters.'; return; }
      body.password = password;
    }
    if (!name && !password) { if (errEl) errEl.textContent = 'Nothing to update.'; return; }
    if (errEl) errEl.textContent = 'Saving...';

    const result = await this._authRequest(body);
    if (result.error) { if (errEl) errEl.textContent = result.error; return; }

    if (name) {
      auth.displayName = name;
      this._setAuth(auth);
      localStorage.setItem('pbook-cert-name', name);
    }
    document.getElementById('editAccountForm').style.display = 'none';
    this._renderSettingsAccount();
    this.renderProfile();
  }

  _renderSettingsThemes() {
    const el = document.getElementById('settingsThemes');
    if (!el) return;
    const rewards = this.getLevelRewards();
    const activeCosmetic = localStorage.getItem('pbook-cosmetic') || null;
    const u = this.user;
    let h = '<div class="cosmetic-grid" style="margin-top:.2em">';
    rewards.forEach(r => {
      const unlocked = u.level >= r.level;
      const active = r.theme ? (r.theme === activeCosmetic) : !activeCosmetic;
      const onclick = unlocked ? (r.theme ? `app.setCosmetic('${r.theme}');app._renderSettingsThemes()` : `app.setCosmetic(null);app._renderSettingsThemes()`) : '';
      h += `<button class="cosmetic-item ${unlocked ? '' : 'cosmetic-locked'} ${active ? 'cosmetic-active' : ''}" ${unlocked ? `onclick="${onclick}"` : ''}>
        <span class="cosmetic-icon">${unlocked ? r.icon : '\u{1F512}'}</span>
        <span class="cosmetic-name">${r.name}</span>
        <span class="cosmetic-level">${unlocked ? (active ? '\u2713' : '') : 'Lv.' + r.level}</span>
      </button>`;
    });
    h += '</div>';
    el.innerHTML = h;
  }

  exportData() {
    const u = this.user;
    const p = u.getProfile(this.allBlocks);
    const data = {
      exportedAt: new Date().toISOString(),
      profile: p,
      user: JSON.parse(localStorage.getItem('pbook-user') || '{}'),
      notes: JSON.parse(localStorage.getItem('pbook-notes') || '{}'),
      highlights: JSON.parse(localStorage.getItem('pbook-highlights') || '{}'),
      interactions: this.rc.interactions,
      features: JSON.parse(localStorage.getItem('pbook-features') || '{}'),
      account: this._getAuth() ? { email: this._getAuth().email, displayName: this._getAuth().displayName } : null,
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `pbook-data-${(p.userId || 'reader').substring(0, 8)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  setTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme === 'light' ? '' : theme);
    localStorage.setItem('pbook-theme', theme);
    this.updateSettingsUI();
  }

  setFontSize(size) {
    const map = { small: '0.95rem', medium: '1.1rem', large: '1.3rem' };
    document.documentElement.style.setProperty('--fs', map[size]);
    localStorage.setItem('pbook-fs', size);
    this.updateSettingsUI();
  }

  applyTheme() {
    const theme = localStorage.getItem('pbook-theme');
    if (theme && theme !== 'light') document.documentElement.setAttribute('data-theme', theme);
    const fs = localStorage.getItem('pbook-fs');
    if (fs) { const map = { small: '0.95rem', medium: '1.1rem', large: '1.3rem' }; document.documentElement.style.setProperty('--fs', map[fs]); }
    this._applyLevelTheme();
    this.updateSettingsUI();
  }

  updateSettingsUI() {
    document.querySelectorAll('.sg-opt').forEach(o => o.classList.remove('active'));
    const fs = localStorage.getItem('pbook-fs') || 'medium';
    document.querySelector(`.sg-opt[data-fs="${fs}"]`)?.classList.add('active');
    // Sync feature checkboxes
    const f = CONFIG.features;
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.checked = val !== false; };
    set('sGamification', f.gamification);
    set('sPersonalization', f.personalization);
    set('sRecall', f.spaceRepetition);
    set('sMissions', f.missions);
    set('sGames', f.games);
    set('sHighlights', f.highlights);
  }

  updateSettingsFeature() {
    const get = id => document.getElementById(id)?.checked !== false;
    const features = {
      gamification: get('sGamification'),
      personalization: get('sPersonalization'),
      spaceRepetition: get('sRecall'),
      missions: get('sMissions'),
      games: get('sGames'),
      highlights: get('sHighlights'),
    };
    localStorage.setItem('pbook-features', JSON.stringify(features));
    Object.assign(CONFIG.features, features);
    if (!features.personalization) this.rc.enabled = false;
    if (!this._f('missions')) document.querySelector('[data-view="glossary"]')?.style.setProperty('display', 'none');
    else document.querySelector('[data-view="glossary"]')?.style.removeProperty('display');
    this.updateXPBadge();
  }


  // Level rewards — cosmetic unlocks
  _renderActivityHeatmap() {
    // Build day → count map from interactions + read blocks
    const dayCounts = {};
    // From interactions (timestamps)
    this.rc.interactions.forEach(i => {
      if (!i.ts) return;
      const day = new Date(i.ts).toISOString().slice(0, 10);
      dayCounts[day] = (dayCounts[day] || 0) + 1;
    });
    // From block signals (dwell timestamps)
    Object.values(this.user.signals).forEach(sig => {
      if (sig.seenAt) { const d = new Date(sig.seenAt).toISOString().slice(0, 10); dayCounts[d] = (dayCounts[d] || 0) + 1; }
    });

    if (Object.keys(dayCounts).length === 0) return '';

    // Last 56 days (8 weeks)
    const today = new Date();
    const days = [];
    for (let i = 55; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      days.push({ key, count: dayCounts[key] || 0, dow: d.getDay() });
    }

    const maxCount = Math.max(...days.map(d => d.count), 1);
    const cellSize = 13, gap = 2, rowH = cellSize + gap;
    const weeks = Math.ceil(days.length / 7);
    const svgW = weeks * (cellSize + gap) + 20;
    const svgH = 7 * rowH + 20;

    const totalActive = days.filter(d => d.count > 0).length;
    const totalInteractions = days.reduce((s, d) => s + d.count, 0);

    let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${svgW} ${svgH}" width="${svgW}" height="${svgH}" style="display:block;max-width:100%">`;
    // Day labels
    const labels = ['', 'M', '', 'W', '', 'F', ''];
    labels.forEach((l, i) => {
      if (l) svg += `<text x="0" y="${i * rowH + cellSize + 2}" font-size="8" fill="var(--text-3)" font-family="var(--font-ui)">${l}</text>`;
    });
    // Cells
    days.forEach((d, i) => {
      const week = Math.floor(i / 7);
      const dow = i % 7;
      const x = 16 + week * (cellSize + gap);
      const y = 2 + dow * rowH;
      const intensity = d.count > 0 ? Math.max(0.2, d.count / maxCount) : 0;
      const fill = d.count === 0 ? 'var(--border-light)' : `rgba(124,58,237,${intensity})`;
      svg += `<rect x="${x}" y="${y}" width="${cellSize}" height="${cellSize}" rx="2" fill="${fill}"><title>${d.key}: ${d.count} interactions</title></rect>`;
    });
    svg += '</svg>';

    let h = '<div class="profile-section"><h3>Your Activity</h3>';
    h += `<div style="display:flex;gap:1em;margin-bottom:.6em;font-size:.78rem">`;
    h += `<span style="color:var(--text-3)">${totalActive} active days</span>`;
    h += `<span style="color:var(--text-3)">${totalInteractions} interactions</span>`;
    h += `</div>`;
    h += svg;
    // Chapter breakdown bars
    const chCounts = {};
    this.rc.interactions.forEach(i => {
      if (i.type !== 'detailview' || !i.itemId) return;
      const block = this.findBlock(i.itemId);
      if (!block) return;
      const ch = block.meta._chapterNum || '?';
      chCounts[ch] = (chCounts[ch] || 0) + 1;
    });
    const chEntries = Object.entries(chCounts).sort((a, b) => a[0] - b[0]);
    if (chEntries.length > 1) {
      const chMax = Math.max(...chEntries.map(([_, c]) => c), 1);
      h += '<div style="margin-top:.8em;font-size:.72rem;color:var(--text-3)">Reading by chapter</div>';
      h += '<div style="display:flex;flex-direction:column;gap:.2em;margin-top:.3em">';
      chEntries.forEach(([ch, count]) => {
        const pct = Math.round((count / chMax) * 100);
        const chTitle = this.book.chapters[ch - 1]?.title || `Chapter ${ch}`;
        h += `<div style="display:flex;align-items:center;gap:.4em;font-size:.72rem">
          <span style="width:1.5em;text-align:right;color:var(--text-3);font-weight:600">${ch}</span>
          <div style="flex:1;height:6px;background:var(--border);border-radius:3px"><div style="width:${pct}%;height:100%;background:var(--accent);border-radius:3px"></div></div>
          <span style="width:2em;color:var(--text-3)">${count}</span>
        </div>`;
      });
      h += '</div>';
    }
    h += '</div>';
    return h;
  }

  getLevelIcon() {
    const rewards = this.getLevelRewards();
    const reward = rewards.filter(r => r.level <= this.user.level).pop();
    return reward?.icon || '\u{1F331}';
  }

  getLevelRewards() {
    return [
      { level: 1, name: 'Default', theme: null, icon: '\u{1F331}' },
      { level: 2, name: 'Ocean', theme: 'ocean', icon: '\u{1F30A}' },
      { level: 3, name: 'Sunset', theme: 'sunset', icon: '\u{1F305}' },
      { level: 4, name: 'Forest', theme: 'forest', icon: '\u{1F332}' },
      { level: 5, name: 'Galaxy', theme: 'galaxy', icon: '\u{1F30C}' },
      { level: 7, name: 'Neon', theme: 'neon', icon: '\u{1F4A1}' },
      { level: 10, name: 'Gold', theme: 'gold', icon: '\u{1F451}' },
    ];
  }

  updateXPBadge() {
    const el = document.getElementById('xpBadge');
    if (!el) return;
    if (!this._f('gamification')) { el.style.display = 'none'; return; }
    el.style.display = '';
    const reward = this.getLevelRewards().filter(r => r.level <= this.user.level).pop();
    el.textContent = (reward?.icon || '') + ' Lv.' + this.user.level + ' · ' + this.user.xp + 'XP';
    // Apply cosmetic theme
    this._applyLevelTheme();
    // Update quiz tab badge
    const quizTab = document.querySelector('.tab[data-view="quiz"] .tab-label');
    if (quizTab && this._f('spaceRepetition')) {
      const dueCount = this.user.getDueRecalls().length;
      quizTab.textContent = dueCount > 0 ? `Quiz (${dueCount})` : 'Quiz';
    }
  }

  _applyLevelTheme() {
    const active = localStorage.getItem('pbook-cosmetic') || null;
    if (active) document.documentElement.setAttribute('data-cosmetic', active);
  }

  setCosmetic(theme) {
    if (theme) {
      localStorage.setItem('pbook-cosmetic', theme);
      document.documentElement.setAttribute('data-cosmetic', theme);
    } else {
      localStorage.removeItem('pbook-cosmetic');
      document.documentElement.removeAttribute('data-cosmetic');
    }
  }

  showXPToast(text, type) {
    if (!this._f('gamification') && type !== 'info') return;
    const toast = document.getElementById('xpToast');
    if (!toast) return;
    toast.textContent = text;
    toast.className = 'xp-toast ' + (type || 'xp') + ' show';
    clearTimeout(this._xpToastTimer);
    this._xpToastTimer = setTimeout(() => { toast.classList.remove('show'); }, 2500);
  }

  // Check for pending gamification events and show toasts
  checkGamificationEvents() {
    if (!this._f('gamification')) return;
    if (this.user._pendingLevelUp) {
      this.showXPToast('Level ' + this.user._pendingLevelUp + '! You are now: ' + this.user.getLevelTitle(), 'levelup');
      this.user._pendingLevelUp = null;
    } else if (this.user._pendingAchievement) {
      const a = this.user._pendingAchievement;
      this.showXPToast(a.icon + ' ' + a.name + '!', 'achievement');
      this.user._pendingAchievement = null;
    }
    this.updateXPBadge();
  }

  updateVoiceBadge() {
    const el = document.getElementById('voiceBadge');
    if (!el) return;
    const v = this.user.preferredVoice || this.user.getTopVoice() || 'universal';
    el.textContent = (CONFIG.voices[v]?.label || v).toUpperCase();
    el.className = `voice-badge ${v}`;
  }


  showCertificateModal() {
    const savedName = localStorage.getItem('pbook-cert-name') || '';
    const savedEmail = localStorage.getItem('pbook-cert-email') || '';
    const overlay = document.createElement('div');
    overlay.className = 'cert-overlay';
    overlay.innerHTML = `
      <div class="cert-modal">
        <button class="cert-close" onclick="this.closest('.cert-overlay').remove()">&times;</button>
        <h2>Your Certificate</h2>
        <p style="font-size:.82rem;color:var(--text-2);margin-bottom:1em">Congratulations on completing the book! Fill in your details to personalize your certificate.</p>
        <label class="cert-label">Your name <span style="color:var(--accent)">*</span></label>
        <input type="text" id="certName" class="cert-input" placeholder="e.g. Maya Johnson" value="${this.escHtml(savedName)}" maxlength="60">
        <label class="cert-label">What did you think of the book? <span style="font-weight:400;color:var(--text-3)">(optional)</span></label>
        <textarea id="certComment" class="cert-input" rows="3" placeholder="I learned that recommendations work by..." maxlength="500"></textarea>
        <label class="cert-label">Would you recommend this book? <span style="font-weight:400;color:var(--text-3)">(optional)</span></label>
        <div class="cert-stars" id="certStars">
          ${[1,2,3,4,5].map(i => `<button class="cert-star" data-val="${i}" onclick="app._setCertStars(${i})">${i <= 0 ? '\u2606' : '\u2606'}</button>`).join('')}
        </div>
        <label class="cert-label">Email <span style="font-weight:400;color:var(--text-3)">(optional — we'll let you know about new books)</span></label>
        <input type="email" id="certEmail" class="cert-input" placeholder="your@email.com" value="${this.escHtml(savedEmail)}" maxlength="120">
        <div class="cert-actions">
          <button class="cert-btn cert-btn-primary" onclick="app.generateCertificate()">Download Certificate</button>
          <button class="cert-btn cert-btn-share" onclick="app.shareCertificate()">Share</button>
        </div>
        <div id="certPreview" style="margin-top:1em"></div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    document.getElementById('certName').focus();
  }

  _setCertStars(n) {
    this._certStars = n;
    document.querySelectorAll('.cert-star').forEach(btn => {
      btn.textContent = parseInt(btn.dataset.val) <= n ? '\u2605' : '\u2606';
      btn.classList.toggle('active', parseInt(btn.dataset.val) <= n);
    });
  }

  _buildCertSVG(name) {
    const u = this.user;
    const p = u.getProfile(this.allBlocks);
    const date = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    const topVoice = u.getTopVoice();
    const voiceLabel = CONFIG.voices[topVoice]?.label || 'Universal';
    const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const displayName = esc(name || 'Anonymous Reader');
    // Adjust font size for long names
    const nameSize = displayName.length > 25 ? 18 : displayName.length > 18 ? 21 : 24;

    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 566" width="800" height="566">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#F5F3FF"/>
      <stop offset="100%" stop-color="#EDE9FE"/>
    </linearGradient>
  </defs>
  <rect width="800" height="566" fill="url(#bg)" rx="16"/>
  <rect x="20" y="20" width="760" height="526" fill="none" stroke="#7C3AED" stroke-width="2" rx="12" stroke-dasharray="8 4"/>
  <rect x="30" y="30" width="740" height="506" fill="none" stroke="#7C3AED" stroke-width="1" rx="10" opacity=".3"/>

  <!-- Header -->
  <text x="400" y="80" text-anchor="middle" font-family="Georgia,serif" font-size="14" fill="#A78BFA" letter-spacing="6">CERTIFICATE OF COMPLETION</text>
  <line x1="200" y1="95" x2="600" y2="95" stroke="#C4B5FD" stroke-width="1"/>

  <!-- Title -->
  <text x="400" y="140" text-anchor="middle" font-family="Georgia,serif" font-size="28" fill="#4C1D95" font-weight="bold">How Recommendations Work</text>
  <text x="400" y="168" text-anchor="middle" font-family="system-ui,sans-serif" font-size="13" fill="#7C3AED">A p-book by Pavel Kordik</text>

  <!-- This certifies -->
  <text x="400" y="210" text-anchor="middle" font-family="system-ui,sans-serif" font-size="12" fill="#6B7280">This certifies that</text>
  <text x="400" y="248" text-anchor="middle" font-family="Georgia,serif" font-size="${nameSize}" fill="#1C1917" font-weight="bold">${displayName}</text>
  <line x1="250" y1="260" x2="550" y2="260" stroke="#D4B5FD" stroke-width="1"/>

  <!-- Achievement stats -->
  <text x="400" y="295" text-anchor="middle" font-family="system-ui,sans-serif" font-size="12" fill="#6B7280">has successfully completed the study of Modern Recommender Systems</text>

  <text x="200" y="335" text-anchor="middle" font-family="system-ui,sans-serif" font-size="11" fill="#7C3AED" font-weight="600">${p.progress.read} sections read</text>
  <text x="400" y="335" text-anchor="middle" font-family="system-ui,sans-serif" font-size="11" fill="#7C3AED" font-weight="600">Level ${u.level} \u2022 ${u.xp} XP</text>
  <text x="600" y="335" text-anchor="middle" font-family="system-ui,sans-serif" font-size="11" fill="#7C3AED" font-weight="600">${u.achievements.length} badges earned</text>

  <text x="200" y="358" text-anchor="middle" font-family="system-ui,sans-serif" font-size="10" fill="#9CA3AF">${p.progress.pct}% complete</text>
  <text x="400" y="358" text-anchor="middle" font-family="system-ui,sans-serif" font-size="10" fill="#9CA3AF">${voiceLabel} path</text>
  <text x="600" y="358" text-anchor="middle" font-family="system-ui,sans-serif" font-size="10" fill="#9CA3AF">${p.readingTimeMin} min reading</text>

  <!-- Specialization -->
  <rect x="280" y="378" width="240" height="30" rx="15" fill="#7C3AED" opacity=".1"/>
  <text x="400" y="398" text-anchor="middle" font-family="system-ui,sans-serif" font-size="12" fill="#7C3AED" font-weight="600">Specialization: ${voiceLabel}</text>

  <!-- Topics -->
  <text x="400" y="438" text-anchor="middle" font-family="system-ui,sans-serif" font-size="10" fill="#9CA3AF">Key topics: ${(p.topTopics || []).slice(0, 4).join(' \u2022 ') || 'Recommender Systems'}</text>

  <!-- Footer -->
  <line x1="150" y1="470" x2="350" y2="470" stroke="#D4B5FD" stroke-width="1"/>
  <text x="250" y="488" text-anchor="middle" font-family="Georgia,serif" font-size="12" fill="#4C1D95">Pavel Kordik</text>
  <text x="250" y="502" text-anchor="middle" font-family="system-ui,sans-serif" font-size="9" fill="#9CA3AF">Author &amp; Recombee Co-founder</text>

  <line x1="450" y1="470" x2="650" y2="470" stroke="#D4B5FD" stroke-width="1"/>
  <text x="550" y="488" text-anchor="middle" font-family="system-ui,sans-serif" font-size="12" fill="#4C1D95">${date}</text>
  <text x="550" y="502" text-anchor="middle" font-family="system-ui,sans-serif" font-size="9" fill="#9CA3AF">Date of completion</text>

  <!-- Seal -->
  <circle cx="400" cy="490" r="22" fill="#7C3AED" opacity=".15"/>
  <text x="400" y="496" text-anchor="middle" font-size="20">\u{1F393}</text>
</svg>`;
  }

  generateCertificate() {
    const nameInput = document.getElementById('certName');
    const name = nameInput?.value?.trim();
    if (!name) { nameInput?.classList.add('cert-error'); nameInput?.focus(); return; }
    nameInput?.classList.remove('cert-error');

    const comment = document.getElementById('certComment')?.value?.trim() || '';
    const email = document.getElementById('certEmail')?.value?.trim() || '';
    const stars = this._certStars || 0;

    // Save locally
    localStorage.setItem('pbook-cert-name', name);
    if (email) localStorage.setItem('pbook-cert-email', email);

    const u = this.user;
    const p = u.getProfile(this.allBlocks);

    // Award certificate achievement
    if (!u.achievements.find(a => a.id === 'certified')) {
      u.achievements.push({ id: 'certified', name: 'Certified!', icon: '\u{1F393}', desc: 'Earned your certificate', earnedAt: Date.now() });
      u.addXP(50);
      u.save();
      this.showXPToast('+50 XP \u{1F393} Certificate earned!', 'achievement');
    }

    // Store to Supabase
    this.rc._sendToLog({
      type: 'certificate',
      userId: localStorage.getItem('pbook-uid') || 'unknown',
      event: 'certificate_issued',
      data: {
        name,
        comment: comment.substring(0, 500),
        email: email.substring(0, 120),
        stars,
        level: u.level,
        xp: u.xp,
        sectionsRead: p.progress.read,
        totalSections: p.progress.total,
        pct: p.progress.pct,
        voice: u.getTopVoice(),
        readingTimeMin: p.readingTimeMin,
        achievements: u.achievements.length,
        completedMissions: (u.completedMissions || []).length,
      }
    });

    // Generate and download SVG
    const svg = this._buildCertSVG(name);
    const blob = new Blob([svg], { type: 'image/svg+xml' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `recsys-certificate-${name.replace(/[^a-zA-Z0-9]/g, '-')}.svg`;
    a.click();
    URL.revokeObjectURL(a.href);

    // Show preview in modal
    const preview = document.getElementById('certPreview');
    if (preview) {
      preview.innerHTML = `<div style="border:1px solid var(--border);border-radius:8px;overflow:hidden;margin-bottom:.5em">${svg.replace('<?xml version="1.0" encoding="UTF-8"?>', '')}</div>
        <p style="font-size:.75rem;color:var(--product);font-weight:600">Certificate downloaded! You can also share it below.</p>`;
    }
  }

  async shareCertificate() {
    const name = document.getElementById('certName')?.value?.trim();
    if (!name) { document.getElementById('certName')?.focus(); return; }

    const svg = this._buildCertSVG(name);

    // Convert SVG to PNG for sharing via canvas
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 800; canvas.height = 566;
      const ctx = canvas.getContext('2d');
      const img = new Image();
      const svgBlob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(svgBlob);

      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = url;
      });
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);

      const pngBlob = await new Promise(r => canvas.toBlob(r, 'image/png'));

      // Try Web Share API (mobile-friendly)
      if (navigator.share && navigator.canShare?.({ files: [new File([pngBlob], 'certificate.png', { type: 'image/png' })] })) {
        await navigator.share({
          title: 'I completed "How Recommendations Work"!',
          text: `I just finished the p-book "How Recommendations Work" by Pavel Kordik and earned my certificate!`,
          files: [new File([pngBlob], 'recsys-certificate.png', { type: 'image/png' })]
        });
      } else {
        // Fallback: copy PNG to clipboard
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
        this.showXPToast('Certificate copied to clipboard! Paste it anywhere to share.', 'info');
      }
    } catch (e) {
      // Final fallback: download the SVG
      const blob = new Blob([svg], { type: 'image/svg+xml' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `recsys-certificate-${name.replace(/[^a-zA-Z0-9]/g, '-')}.svg`;
      a.click();
      URL.revokeObjectURL(a.href);
      this.showXPToast('Certificate saved! Share it with your friends.', 'info');
    }
  }

  resetAll() {
    if (!confirm('Reset all reading data? This clears your progress, notes, and preferences.')) return;
    this.user.reset();
    localStorage.removeItem('pbook-theme');
    localStorage.removeItem('pbook-fs');
    localStorage.removeItem('pbook-uid');
    localStorage.removeItem('pbook-notes');
    localStorage.removeItem('pbook-flags');
    localStorage.removeItem('pbook-state');
    location.reload();
  }

  // ===== HELPERS =====
  findBlock(id) {
    for (const b of this.allBlocks) { if (b.meta.id === id) return b; }
    return null;
  }

  getChapterLabel(block) {
    for (const [i, ch] of Object.entries(this.chapters)) {
      if (ch.blocks.some(b => b.id === block.id)) return `Ch${ch.number}: ${ch.title}`;
    }
    return '';
  }
}

// ===== INIT =====
const app = new PBook();
window.app = app;
app.init();

// Text highlight on selection (desktop + mobile)
function _showHighlightPopup() {
  const popup = document.getElementById('highlightPopup');
  if (!popup) return;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.toString().trim()) { popup.style.display = 'none'; return; }
  const anchor = sel.anchorNode?.parentElement?.closest('.spine-body, .d-content, .sb-block');
  if (!anchor) { popup.style.display = 'none'; return; }
  const range = sel.getRangeAt(0);
  const rect = range.getBoundingClientRect();
  popup.style.display = 'flex';
  popup.style.top = (rect.top + window.scrollY - 40) + 'px';
  popup.style.left = Math.max(8, Math.min(rect.left + rect.width / 2 - 40, window.innerWidth - 90)) + 'px';
}
document.addEventListener('mouseup', _showHighlightPopup);
// Mobile: selectionchange fires when user adjusts selection handles
document.addEventListener('selectionchange', () => {
  clearTimeout(window._hlDebounce);
  window._hlDebounce = setTimeout(_showHighlightPopup, 300);
});

// Click on highlight to remove it
document.addEventListener('click', (e) => {
  const mark = e.target.closest('mark.user-highlight');
  if (!mark) return;
  // Don't remove if user is selecting text (mouseup fires click too)
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed) return;
  // Don't remove during flash animation
  if (mark.classList.contains('highlight-flash')) return;
  // Unwrap: replace <mark> with its text content
  const parent = mark.parentNode;
  while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
  parent.removeChild(mark);
  parent.normalize();
});

// Keyboard: arrows for chapter nav in read view
document.addEventListener('keydown', e => {
  if (app.currentView !== 'read' || !app.book) return;
  if (e.key === 'ArrowRight' && app.user.currentChapter < app.book.chapters.length - 1) app.goChapter(app.user.currentChapter + 1);
  if (e.key === 'ArrowLeft' && app.user.currentChapter > 0) app.goChapter(app.user.currentChapter - 1);
});
