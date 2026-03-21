// p-book v3: Adaptive UX with Netflix home, map, search, feedback, Recombee-powered

import { CONFIG } from './config.js';
import { renderMarkdown, parseFrontmatter } from './markdown.js';
import { RecombeeClient, UserModel } from './recombee.js';
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

    // Sync voice preference to Recombee
    if (this.user.preferredVoice && this.rc.enabled) {
      this.rc.setUserProperties({ voice: this.user.preferredVoice });
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

    // Apply saved settings
    if (this.user.preferredVoice || this.user.totalInteractions > 0) {
      this.startApp();
    }
    this.applyTheme();
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
      const valid = blocks.filter(Boolean).sort((a, b) => a.sequence - b.sequence);
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

  pickVoice(el) {
    document.querySelectorAll('.opt-card').forEach(o => o.classList.remove('selected'));
    el.classList.add('selected');
    this.user.setVoice(el.dataset.voice);
    setTimeout(() => this.startApp(), 400);
  }

  startReading() { this.startApp(); }

  startAndGo(view) {
    document.getElementById('onboarding').classList.add('hidden');
    this.updateVoiceBadge();
    this.updateXPBadge();
    this.switchView(view || 'home');
  }

  showWelcome() {
    const overlay = document.getElementById('onboarding');
    overlay.classList.remove('hidden');
    this.showStep(0);
  }

  startApp() {
    document.getElementById('onboarding').classList.add('hidden');
    this.updateVoiceBadge();
    this.updateXPBadge();
    this.switchView('home');
  }

  // ===== VIEW SWITCHING =====
  switchView(view) {
    this.currentView = view;

    // Hide all views, show the selected one
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    const viewEl = document.getElementById(`view-${view}`);
    if (viewEl) viewEl.classList.add('active');

    // Update tab highlights
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === view));

    // Linear nav only in read view
    const linearNav = document.getElementById('linearNav');
    if (linearNav) linearNav.style.display = view === 'read' ? 'flex' : 'none';

    if (view === 'home') this.renderHome();
    else if (view === 'read') { this.renderRead(); this.updateLinearNav(); }
    else if (view === 'map') this.renderMap();
    else if (view === 'glossary') this.renderMissions();
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

    // Recall cards if due
    const dueRecalls = this.user.getDueRecalls();
    if (dueRecalls.length > 0) {
      const recallCards = dueRecalls.slice(0, 6).map(r => {
        const block = this.findBlock(r.blockId);
        if (!block) return '';
        const quiz = this._getRecallQuestion(block);
        return `<div class="card recall-card" style="border-top: 3px solid #F59E0B; flex: 0 0 280px">
          <div class="card-chapter" style="color:#F59E0B;font-weight:700">Do you remember?</div>
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
      }).filter(Boolean);
      if (recallCards.length) html += this.shelf('Do you remember?', recallCards);
    }

    // Active missions
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

    // 2. Recommended for you
    const forYou = await this.rc.getRecsForUser('pbook:personal', 8, this.rc.reql({ type: 'spine' }), this.rc.reqlBoost(this.user));
    if (forYou?.recomms?.length) {
      html += this.shelf('Picked for you', forYou.recomms.map(r => this.cardFromRec(r)));
    }

    // 3. Matching your interest (preferred voice depth cards)
    const topVoice = this.user.getTopVoice();
    if (topVoice) {
      const voiceLabel = CONFIG.voices[topVoice]?.label || topVoice;
      const voiceBlocks = this.allBlocks.filter(b => b.meta.voice === topVoice && b.meta.type === 'depth' && !this.user.readBlocks.has(b.meta.id)).slice(0, 10);
      if (voiceBlocks.length) {
        html += this.shelf(`${voiceLabel} deep dives`, voiceBlocks.map(b => this.cardHtml(b.meta)));
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
    const badge = block.type === 'depth' ? `<span class="card-badge ${block.voice}">${CONFIG.voices[block.voice]?.label || block.voice}</span>` :
                  block.type === 'sidebar' ? '<span class="card-badge sidebar">Story</span>' : '';
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
    const borderStyle = block.type === 'depth' && block.voice ? `border-top: 3px solid var(--${block.voice})` :
                        block.type === 'sidebar' ? 'border-top: 3px solid var(--sidebar-color)' : '';

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
    const v = rec.values || {};
    return `<div class="card" onclick="app.openBlock('${rec.id}')"><div class="card-title">${v.title || rec.id}</div><div class="card-meta"><span class="card-time">${v.readingTime || 3} min</span></div></div>`;
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

    // Render math, context panel, observe blocks
    this.renderMath();
    this.renderContext(ch, idx);
    this._observeBlocks(ch);
    this.updateLinearNav();
    this._updateMissionBar();
    this._showMissionIntro();
  }

  async _renderChapterContent(ch, idx) {
    const visibleVoices = this.user.getVisibleVoices();
    const depths = ch.blocks.filter(b => b.type === 'depth');
    const sidebars = ch.blocks.filter(b => b.type === 'sidebar');

    let html = `<div class="ch-head fade-up" id="ch-head-${idx}"><div class="ch-label">Chapter ${ch.number}</div><h2>${ch.title}</h2><div class="ch-sub">${ch.subtitle}</div></div>`;

    for (const block of ch.blocks) {
      if (block.type === 'spine') {
        html += await this.renderSpine(block);
        const blockDepths = depths.filter(d => d.parent === block.id && visibleVoices.includes(d.voice));
        if (blockDepths.length) html += this.renderDepthGroup(blockDepths, block.id);
        sidebars.filter(s => s.parent === block.id).forEach(s => { html += this.renderSidebar(s); });
      } else if (block.type === 'question') {
        html += this.renderQuestion(block);
      } else if (block.type === 'sidebar' && !block.parent) {
        html += this.renderSidebar(block);
      }
    }
    return html;
  }

  _setupInfiniteScroll(pane, startIdx) {
    if (this._scrollHandler) window.removeEventListener('scroll', this._scrollHandler);
    this._isLoadingMore = false;

    this._scrollHandler = async () => {
      if (this._isLoadingMore || this.currentView !== 'read') return;
      // Check if near bottom (within 600px)
      const scrollBottom = window.innerHeight + window.scrollY;
      const docHeight = document.documentElement.scrollHeight;
      if (scrollBottom < docHeight - 600) return;

      this._isLoadingMore = true;

      // Ask Recombee what chapter/block to show next
      const nextChIdx = await this._getNextChapter();
      if (nextChIdx !== null && !this._loadedChapters.has(nextChIdx)) {
        const nextCh = this.chapters[nextChIdx];
        if (nextCh) {
          this._loadedChapters.add(nextChIdx);
          const html = await this._renderChapterContent(nextCh, nextChIdx);
          pane.insertAdjacentHTML('beforeend', '<hr style="margin:2em 0;border:none;border-top:2px solid var(--border)">');
          pane.insertAdjacentHTML('beforeend', html);
          this.renderMath();
          this._observeBlocks(nextCh);
          this.user.currentChapter = nextChIdx;
          this.user.save();
          this.updateLinearNav();
        }
      }
      this._isLoadingMore = false;
    };

    window.addEventListener('scroll', this._scrollHandler, { passive: true });
  }

  async _getNextChapter() {
    // Try Recombee first — ask for next recommended spine block
    if (this.rc.enabled) {
      const readIds = [...this.user.readBlocks].join(',');
      const result = await this.rc.getRecsForUser('pbook:next-read', 1,
        this.rc.reql({ type: 'spine' }));
      if (result?.recomms?.length) {
        const recId = result.recomms[0].id;
        const block = this.findBlock(recId);
        if (block) return block.meta._chapterIdx;
      }
    }
    // Fallback: next chapter in sequence that hasn't been loaded
    const loaded = this._loadedChapters || new Set();
    for (let i = 0; i < this.book.chapters.length; i++) {
      if (!loaded.has(i)) return i;
    }
    return null;
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
              this.updateContext(id);
            }

            // After reading time: mark as "read"
            if (elapsed >= readTimeMs && !this.user.readBlocks.has(id)) {
              this.user.trackRead(id);
              this.rc.sendView(id, Math.round(elapsed / 1000));
              e.target.querySelector('.block-status')?.classList.remove('seen');
              e.target.querySelector('.block-status')?.classList.add('read');
              this.updateContext(id);
              this._updateInlineReadNext(id, ownerCh);
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

  async renderSpine(block) {
    const bodyHtml = renderMarkdown(block.body);
    let diagramHtml = '';
    if (block.diagram) { const svg = await getDiagram(block.diagram); diagramHtml = `<div class="diagram-wrap">${svg}</div>`; }
    const isRead = this.user.readBlocks.has(block.id);
    const savedNote = this.getNote(block.id);
    const noteHtml = savedNote ? `<div class="block-note-display"><span class="note-icon">&#128221;</span><span>${this.escHtml(savedNote)}</span><button class="note-edit" onclick="app.editNote('${block.id}')">edit</button></div>` : '';

    return `<article class="block-article fade-up" id="b-${block.id}">
      <div class="block-header">
        <div class="block-status ${isRead ? 'read' : ''}"></div>
        <h3>${block.title}</h3>
        <div class="block-meta">
          <span>${block.readingTime || 3} min read</span>
          ${block.standalone ? '<span class="meta-standalone">Standalone</span>' : ''}
        </div>
      </div>
      ${diagramHtml}
      <div class="spine-body">${bodyHtml}</div>
      ${noteHtml}
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
          <button class="act-btn ${this.user.savedBlocks.has(block.id)?'active':''}" onclick="app.saveBlock('${block.id}')" title="Save">&#128278;</button>
          <button class="act-btn flag-btn" onclick="app.flagBlock('${block.id}')" title="Suggest edit to author">&#9873;</button>
        </div>
      </div>
      <div class="note-editor" id="note-${block.id}" style="display:none">
        <textarea placeholder="Your private note on this section..." id="note-text-${block.id}">${this.escHtml(savedNote || '')}</textarea>
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

  // Notes system
  getNote(blockId) {
    try { const notes = JSON.parse(localStorage.getItem('pbook-notes') || '{}'); return notes[blockId] || ''; } catch(e) { return ''; }
  }
  toggleNote(blockId) {
    const ed = document.getElementById(`note-${blockId}`);
    if (!ed) return;
    const visible = ed.style.display !== 'none';
    ed.style.display = visible ? 'none' : 'block';
    if (!visible) ed.querySelector('textarea')?.focus();
  }
  editNote(blockId) { this.toggleNote(blockId); }
  saveNote(blockId) {
    const text = document.getElementById(`note-text-${blockId}`)?.value?.trim() || '';
    try {
      const notes = JSON.parse(localStorage.getItem('pbook-notes') || '{}');
      if (text) { notes[blockId] = text; this.user.trackNote(blockId); }
      else delete notes[blockId];
      localStorage.setItem('pbook-notes', JSON.stringify(notes));
    } catch(e) {}
    this.toggleNote(blockId);
    // Re-render note display
    const article = document.getElementById(`b-${blockId}`);
    const existing = article?.querySelector('.block-note-display');
    if (text && !existing) {
      const div = document.createElement('div');
      div.className = 'block-note-display';
      div.innerHTML = `<span class="note-icon">&#128221;</span><span>${this.escHtml(text)}</span><button class="note-edit" onclick="app.editNote('${blockId}')">edit</button>`;
      article?.querySelector('.block-footer')?.before(div);
    } else if (existing) {
      if (text) existing.querySelector('span:last-of-type').textContent = text;
      else existing.remove();
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

  highlightSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    try {
      const range = sel.getRangeAt(0);
      const mark = document.createElement('mark');
      mark.className = 'user-highlight';
      range.surroundContents(mark);
      // Find which block this is in
      const article = mark.closest('.block-article');
      const blockId = article?.id?.replace('b-', '');
      if (blockId) {
        this._saveHighlight(blockId, sel.toString());
        this.rc.sendRating(blockId, 0.8); // highlight = strong positive signal
      }
    } catch (e) { /* selection spans elements */ }
    sel.removeAllRanges();
    document.getElementById('highlightPopup').style.display = 'none';
  }

  highlightAndNote() {
    const sel = window.getSelection();
    const text = sel?.toString() || '';
    this.highlightSelection();
    // Find the block and open note with pre-filled highlight
    const mark = document.querySelector('.user-highlight:last-of-type');
    const article = mark?.closest('.block-article');
    const blockId = article?.id?.replace('b-', '');
    if (blockId) {
      this.toggleNote(blockId);
      const textarea = document.getElementById(`note-text-${blockId}`);
      if (textarea && !textarea.value) textarea.value = `"${text}" — `;
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

  renderDepthGroup(depths, parentId) {
    const topVoice = this.user.getTopVoice();
    const tabsHtml = depths.map(d => {
      const vc = CONFIG.voices[d.voice] || {};
      const isDefault = d.voice === topVoice;
      return `<button class="d-tab ${d.voice} ${isDefault ? 'active' : ''}" data-voice="${d.voice}" onclick="app.toggleDepth('${d.id}','${parentId}','${d.voice}')"> ${vc.icon || ''} ${vc.label || d.voice} <span class="t-time">${d.readingTime || 3}m</span></button>`;
    }).join('');
    const cardsHtml = depths.map(d => {
      const vc = CONFIG.voices[d.voice] || {};
      const isDefault = d.voice === topVoice;
      return `<div class="d-content ${d.voice} ${isDefault ? 'active' : ''}" id="dc-${d.id}"><span class="vlabel">${vc.label || d.voice} perspective</span><h4>${d.title}</h4>${renderMarkdown(d.body)}</div>`;
    }).join('');
    // Auto-track if default voice is expanded
    if (topVoice) {
      const autoBlock = depths.find(d => d.voice === topVoice);
      if (autoBlock) setTimeout(() => this.rc.sendView(autoBlock.id), 100);
    }
    return `<div class="depth-group" data-parent="${parentId}"><div class="depth-tabs">${tabsHtml}</div>${cardsHtml}</div>`;
  }

  renderSidebar(block) {
    return `<div class="sb-block fade-up"><div class="sb-label">&#9670; Sidebar</div><h4>${block.title}</h4>${renderMarkdown(block.body)}</div>`;
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
      const optRegex = /\*\*([A-D])\)?\*?\*?[:\s]*"?([^"*\n]+)"?\*?\*/g;
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
    // Also find a related block from another chapter
    const otherChapterBlock = this.allBlocks.find(b =>
      b._chapter !== ch.id && b.meta.type === 'spine' && !this.user.readBlocks.has(b.meta.id)
    );

    let items = '';
    if (nextInChapter) {
      items += `<div class="rn-item" onclick="app.openBlock('${nextInChapter.id}')"><span class="rn-label">Next in chapter</span><span class="rn-title">${nextInChapter.title}</span><span class="rn-time">${nextInChapter.readingTime || 3}m</span></div>`;
    }
    if (otherChapterBlock) {
      items += `<div class="rn-item" onclick="app.openBlock('${otherChapterBlock.meta.id}')"><span class="rn-label">From Ch${otherChapterBlock.meta._chapterNum}</span><span class="rn-title">${otherChapterBlock.meta.title}</span><span class="rn-time">${otherChapterBlock.meta.readingTime || 3}m</span></div>`;
    }
    if (!items) return '';
    return `<div class="read-next" id="rn-${blockId}">${items}</div>`;
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

  renderChapterNav(idx) {
    const prev = idx > 0 ? this.book.chapters[idx - 1] : null;
    const next = idx < this.book.chapters.length - 1 ? this.book.chapters[idx + 1] : null;
    return `<div class="ch-nav"><button class="ch-nav-btn ${prev ? '' : 'disabled'}" onclick="${prev ? `app.goChapter(${idx - 1})` : ''}"><span class="nl">&larr; Previous</span>${prev ? `${prev.number}. ${prev.title}` : ''}</button><button class="ch-nav-btn ${next ? '' : 'disabled'}" onclick="${next ? `app.goChapter(${idx + 1})` : ''}"><span class="nl">Next &rarr;</span>${next ? `${next.number}. ${next.title}` : ''}</button></div>`;
  }

  renderContext(ch, idx) {
    this._ctxChapter = ch;
    this._ctxIdx = idx;
    this.updateContext();
  }

  updateContext(currentBlockId) {
    const ch = this._ctxChapter;
    if (!ch) return;

    const show = (id, html) => { const el = document.getElementById(id); if (el) { el.innerHTML = html; el.style.display = 'block'; }};
    const hide = (id) => { const el = document.getElementById(id); if (el) el.style.display = 'none'; };

    // 1. Current block metadata
    const currentBlock = currentBlockId ? ch.blocks.find(b => b.id === currentBlockId) : ch.blocks.find(b => b.type === 'spine');
    if (currentBlock) {
      const topics = (this.blockTopics[currentBlock.id] || []).slice(0, 4);
      const sig = this.user.getBlockSignals(currentBlock.id);
      const depthCards = ch.blocks.filter(b => b.type === 'depth' && b.parent === currentBlock.id);
      const sidebarCards = ch.blocks.filter(b => b.type === 'sidebar' && b.parent === currentBlock.id);

      let meta = `<h4>Current section</h4>`;
      meta += `<div class="ctx-current-title">${currentBlock.title}</div>`;
      meta += `<div class="ctx-meta-row"><span>Ch${ch.number}</span><span>${currentBlock.readingTime || 3} min</span>`;
      if (sig.dwellMs > 1000) meta += `<span>&#9201; ${Math.round(sig.dwellMs/1000)}s read</span>`;
      meta += `</div>`;
      if (topics.length) meta += `<div class="ctx-topics">${topics.map(t => `<span class="ctx-topic" onclick="app.showTopic('${t}')">${t}</span>`).join('')}</div>`;
      if (depthCards.length) meta += `<div class="ctx-depths"><span class="ctx-depths-label">Deep dives:</span>${depthCards.map(d => `<span class="ctx-depth-badge ${d.voice}">${CONFIG.voices[d.voice]?.label || d.voice}</span>`).join('')}</div>`;
      show('ctxMeta', meta);
    }

    // 2. Up next
    const nextBlock = this.getContinueBlock();
    if (nextBlock) {
      show('ctxNext', `<h4>Up next</h4><div class="ctx-next" onclick="app.openBlock('${nextBlock.id}')"><span class="ctx-next-label">Continue</span><span>${nextBlock.title}</span></div>`);
    } else hide('ctxNext');

    // 3. Related
    const pool = this.allBlocks.filter(b => b._chapter !== ch.id && b.meta.type === 'spine');
    const unread = pool.filter(b => !this.user.readBlocks.has(b.meta.id));
    const related = (unread.length >= 4 ? unread : [...unread, ...pool]).sort(() => Math.random() - 0.5).slice(0, 4);
    show('ctxRelated', `<h4>Related</h4>${related.map(b =>
      `<div class="ctx-item" onclick="app.openBlock('${b.meta.id}')"><span>Ch${b.meta._chapterNum}: ${b.meta.title}</span></div>`
    ).join('')}`);

    // 4. Quiz / comprehension check
    if (currentBlock) {
      const quiz = this._generateQuiz(currentBlock);
      if (quiz) show('ctxQuiz', quiz);
      else hide('ctxQuiz');
    }

    // 5. Chat with suggested questions
    const ctxChat = document.getElementById('ctxChat');
    if (ctxChat) {
      const suggested = currentBlock ? this.tutor.getSuggestedQuestions({ meta: currentBlock, body: currentBlock.body || this.findBlock(currentBlock.id)?.body }) : [];
      const sugHtml = suggested.length ? suggested.map(q =>
        `<button class="tutor-suggest-btn" style="font-size:.7rem;padding:.25em .5em" onclick="document.getElementById('chatInput').value='${q.replace(/'/g,"\\'")}';app.sendChat()">${q}</button>`
      ).join('') : '';
      ctxChat.style.display = 'block';
      if (!ctxChat.dataset.init) {
        ctxChat.dataset.init = '1';
        ctxChat.innerHTML = `<h4>&#129302; Ask the tutor</h4>
          <div class="ctx-chat-messages" id="chatMessages"><div class="chat-msg bot" style="font-size:.75rem">Ask me anything about what you're reading!</div></div>
          ${sugHtml ? `<div class="tutor-suggestions" style="padding:0 0 .3em">${sugHtml}</div>` : ''}
          <div class="ctx-chat-input">
            <input type="text" id="chatInput" placeholder="Ask about this section..." onkeydown="if(event.key==='Enter')app.sendChat()">
            <button onclick="app.sendChat()">&#10148;</button>
          </div>`;
      }
    }
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
    const body = (block.body || '').toLowerCase();
    const title = block.meta.title || '';

    // Generate recall questions based on content keywords
    if (body.includes('collaborative filter')) return { q: 'How does collaborative filtering find recommendations?', a: 'It finds people with similar taste to you, then recommends things THEY liked that you haven\'t seen yet.' };
    if (body.includes('content-based')) return { q: 'What does content-based filtering look at?', a: 'It looks at the FEATURES of items you liked (genre, tags, description) and finds similar items.' };
    if (body.includes('cold start')) return { q: 'What is the "cold start" problem?', a: 'When a new user or item has no data yet, the system can\'t make good recommendations. It\'s "cold" because there\'s no history to learn from.' };
    if (body.includes('filter bubble')) return { q: 'What is a filter bubble?', a: 'When recommendations only show you things you already like, trapping you in a bubble where you never discover anything new.' };
    if (body.includes('echo chamber')) return { q: 'How is an echo chamber different from a filter bubble?', a: 'An echo chamber is worse — it makes you think everyone agrees with you because you only hear your own opinions reflected back.' };
    if (body.includes('a/b test')) return { q: 'What is an A/B test?', a: 'A real experiment where half the users see version A and half see version B. You compare results to find which is actually better.' };
    if (body.includes('digital footprint') || body.includes('footprint')) return { q: 'What are "digital footprints"?', a: 'Every click, watch, skip, and search you make online — like invisible tracks that tell algorithms about your interests.' };
    if (body.includes('implicit') && body.includes('explicit')) return { q: 'What\'s the difference between implicit and explicit feedback?', a: 'Explicit = you TELL the system (ratings, likes). Implicit = the system WATCHES what you do (clicks, time spent, skips).' };
    if (body.includes('pipeline') || (body.includes('find') && body.includes('rank'))) return { q: 'What are the 3 stages of a recommendation pipeline?', a: 'FIND (gather candidates), RANK (score them for you), CHECK (add diversity, remove duplicates).' };
    if (body.includes('popular') && body.includes('trending')) return { q: 'Why isn\'t "show what\'s popular" the best strategy?', a: 'Because popular items are the same for everyone — they don\'t know YOUR unique taste. A good system is personal.' };
    if (body.includes('matrix factor') || body.includes('svd')) return { q: 'What does matrix factorization do?', a: 'It finds hidden patterns in a big grid of ratings by breaking it into simpler pieces — discovering "latent factors" like genre preferences.' };
    if (body.includes('autoplay') || body.includes('infinite scroll')) return { q: 'Why is autoplay/infinite scroll designed the way it is?', a: 'To remove stopping points — there\'s always something next. It\'s like a bag of chips that never runs out. Recognizing this helps you stay in control.' };
    if (body.includes('dopamine')) return { q: 'What brain chemical makes you want to watch "just one more"?', a: 'Dopamine! Released when you see something surprising or rewarding. The uncertainty of "will the next one be good?" creates a loop.' };
    if (body.includes('privacy') || body.includes('gdpr')) return { q: 'What can you do to protect your privacy online?', a: 'Use privacy-focused browsers, check app permissions, clear history, use "not interested" buttons, and know your rights (like GDPR).' };
    if (body.includes('third-party cookie') || body.includes('tracker')) return { q: 'How do third-party trackers follow you across websites?', a: 'They hide tiny code on many websites. When you visit any site using the same tracker, they recognize you and build a profile across ALL your browsing.' };
    if (body.includes('diversity') || body.includes('long tail')) return { q: 'Why is diversity important in recommendations?', a: 'Without it, popular items get recommended more and more while new/niche content gets buried. Diversity gives everything a fair chance.' };

    // Fallback: ask about the section title
    return { q: `Can you explain "${title}" in your own words?`, a: `Re-read the section "${title}" to refresh your memory. The best way to learn is to explain things simply!` };
  }

  startPractice() {
    // Pick random read blocks for practice (even if not due yet)
    const readIds = [...this.user.readBlocks];
    if (readIds.length === 0) return;
    const shuffled = readIds.sort(() => Math.random() - 0.5).slice(0, 6);
    const el = document.getElementById('homeContent');
    const cards = shuffled.map(blockId => {
      const block = this.findBlock(blockId);
      if (!block) return '';
      const quiz = this._getRecallQuestion(block);
      return `<div class="card recall-card" style="border-top: 3px solid #F59E0B; flex: 0 0 280px">
        <div class="card-chapter" style="color:#F59E0B;font-weight:700">Practice recall</div>
        <div class="card-title">${quiz.q}</div>
        <div class="recall-answer" id="recall-a-${blockId}" style="display:none">
          <div class="recall-answer-text">${quiz.a}</div>
          <div class="recall-hint" style="font-size:.7rem;color:var(--text-3);margin:.3em 0">From: ${block.meta.title}</div>
          <div class="recall-buttons">
            <button class="recall-btn recall-forgot" onclick="app.scoreRecall('${blockId}',0)">Forgot</button>
            <button class="recall-btn recall-hard" onclick="app.scoreRecall('${blockId}',1)">Hard</button>
            <button class="recall-btn recall-good" onclick="app.scoreRecall('${blockId}',2)">Good</button>
            <button class="recall-btn recall-easy" onclick="app.scoreRecall('${blockId}',3)">Easy!</button>
          </div>
        </div>
        <button class="recall-reveal" id="recall-r-${blockId}" onclick="document.getElementById('recall-a-${blockId}').style.display='block';this.style.display='none'">Show answer</button>
      </div>`;
    }).filter(Boolean);
    if (cards.length) {
      // Prepend practice shelf to home
      const practiceHtml = this.shelf('Practice mode', cards);
      el.insertAdjacentHTML('afterbegin', practiceHtml);
      this._updateShelfArrows();
      setTimeout(() => this._updateShelfArrows(), 300);
      window.scrollTo(0, 0);
    }
  }

  scoreRecall(blockId, quality) {
    const xpEarned = this.user.processRecall(blockId, quality);
    const labels = ['Forgot — we\'ll try again soon!', 'Hard — keep at it!', 'Good — nice memory!', 'Easy — you\'re a pro!'];
    this.showXPToast(`+${xpEarned} XP — ${labels[quality]}`, quality >= 2 ? 'xp' : 'info');
    this.checkGamificationEvents();
    // Remove the card from view
    const card = document.getElementById(`recall-a-${blockId}`)?.closest('.card');
    if (card) {
      card.style.transition = 'opacity 0.3s, transform 0.3s';
      card.style.opacity = '0';
      card.style.transform = 'scale(0.9)';
      setTimeout(() => card.remove(), 300);
    }
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
    const mapMode = this._mapMode || 'visual';

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
      </div>
      <button class="map-reset-btn" onclick="app.resetAll()">Reset progress</button>
    </div>`;

    if (false) { // old paths mode removed — now in Missions tab
    }

    if (mapMode === 'visual') {
      html += this.renderVisualMap(visibleVoices);
      el.innerHTML = html;
      return;
    }

    // List mode legend
    html += `<div class="map-legend">
      <span class="ml-item"><svg width="10" height="10"><circle cx="5" cy="5" r="4" fill="#059669"/></svg> Read</span>
      <span class="ml-item"><svg width="14" height="14"><circle cx="7" cy="7" r="4" fill="#D97706" stroke="#D97706" stroke-width="3" opacity=".3"/><circle cx="7" cy="7" r="4" fill="#D97706"/></svg> Next</span>
      <span class="ml-item"><svg width="10" height="10"><circle cx="5" cy="5" r="4" fill="#E7E5E4"/></svg> Unread</span>
      <span class="ml-item"><svg width="10" height="10"><circle cx="5" cy="5" r="3.5" fill="none" stroke="#57534E" stroke-width="1.5"/></svg> Depth</span>
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
      const spines = blocks.filter(b => b.type === 'spine');
      const depths = blocks.filter(b => b.type === 'depth');
      const sidebars = blocks.filter(b => b.type === 'sidebar');
      const readCount = spines.filter(b => this.user.readBlocks.has(b.id)).length;
      const totalCount = spines.length;
      const chPct = Math.round((readCount / Math.max(totalCount, 1)) * 100);

      // Check if prerequisites are met
      const prereqs = chapterPrereqs[ci] || [];
      const prereqsMet = prereqs.every(pi => {
        const pSpines = (this.chapters[pi]?.blocks || []).filter(b => b.type === 'spine');
        const pRead = pSpines.filter(b => this.user.readBlocks.has(b.id)).length;
        return pRead >= Math.ceil(pSpines.length * 0.5); // At least 50% read
      });
      const prereqLabels = prereqs.map(pi => `Ch${this.book.chapters[pi].number}`).join(', ');
      const isLocked = !prereqsMet && prereqs.length > 0 && readCount === 0;

      html += `<div class="map-chapter ${isLocked ? 'map-ch-locked' : ''} fade-up">`;

      // Chapter header with progress ring
      html += `<div class="map-ch-head" onclick="app.goChapter(${ci})">
        <div class="map-ch-ring" data-pct="${chPct}">
          <svg viewBox="0 0 36 36"><circle cx="18" cy="18" r="16" fill="none" stroke="var(--border)" stroke-width="2.5"/>
          <circle cx="18" cy="18" r="16" fill="none" stroke="${chPct === 100 ? 'var(--product)' : 'var(--accent)'}" stroke-width="2.5" stroke-dasharray="${chPct} ${100 - chPct}" stroke-dashoffset="25" stroke-linecap="round"/></svg>
          <span class="map-ch-num">${ch.number}</span>
        </div>
        <div class="map-ch-info">
          <div class="map-ch-title">${ch.title}</div>
          <div class="map-ch-sub">${ch.subtitle}</div>
          <div class="map-ch-stats">${readCount}/${totalCount} sections${isLocked ? ` &middot; <span class="map-prereq">Read ${prereqLabels} first</span>` : ''}</div>
        </div>
        <div class="map-ch-arrow">&rsaquo;</div>
      </div>`;

      // Spine blocks with their depth cards + signals
      html += '<div class="map-blocks">';
      spines.forEach((spine, si) => {
        const isRead = this.user.readBlocks.has(spine.id);
        const isSeen = this.user.seenBlocks.has(spine.id);
        const isSuggested = suggestedNext === spine.id;
        const sig = this.user.getBlockSignals(spine.id);
        const spineDepths = depths.filter(d => d.parent === spine.id);
        const spineDepthsVisible = spineDepths.filter(d => visibleVoices.includes(d.voice));
        const spineSidebars = sidebars.filter(s => s.parent === spine.id);
        const hasChildren = spineDepthsVisible.length > 0 || spineSidebars.length > 0;

        // Signal icons for this block
        const signals = this._signalIcons(sig, spine.id);

        html += `<div class="map-spine-group">
          <div class="map-block map-spine ${isRead ? 'read' : isSeen ? 'seen' : ''} ${isSuggested ? 'suggested' : ''}" onclick="app.openBlock('${spine.id}')">
            <div class="map-dot ${isRead ? 'done' : isSeen ? 'seen-dot' : ''} ${isSuggested ? 'next' : ''}"></div>
            <span class="map-block-title">${spine.title}</span>
            <span class="map-signals">${signals}</span>
            <span class="map-block-time">${spine.readingTime || 3}m</span>
          </div>`;

        // Depth cards + sidebars
        if (hasChildren) {
          html += '<div class="map-children">';
          spineDepthsVisible.forEach(d => {
            const dRead = this.user.readBlocks.has(d.id);
            const dSeen = this.user.seenBlocks.has(d.id);
            const dSig = this.user.getBlockSignals(d.id);
            const vc = CONFIG.voices[d.voice] || {};
            const dSignals = this._signalIcons(dSig, d.id);
            html += `<div class="map-block map-depth ${dRead ? 'read' : dSeen ? 'seen' : ''}" onclick="app.openBlock('${d.parent}')">
              <div class="map-dot depth-dot" style="border-color:var(--${d.voice})"></div>
              <span class="map-block-title">${d.title}</span>
              <span class="map-signals">${dSignals}</span>
              <span class="map-voice-tag ${d.voice}">${vc.label || d.voice}</span>
            </div>`;
          });
          spineSidebars.forEach(s => {
            const sSig = this.user.getBlockSignals(s.id);
            const sSignals = this._signalIcons(sSig, s.id);
            html += `<div class="map-block map-depth" onclick="app.openBlock('${s.parent}')">
              <div class="map-dot depth-dot" style="border-color:var(--sidebar-color)"></div>
              <span class="map-block-title">${s.title}</span>
              <span class="map-signals">${sSignals}</span>
              <span class="map-voice-tag" style="background:var(--sidebar-color)">Story</span>
            </div>`;
          });
          html += '</div>';
        }
        html += '</div>';
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

  // ===== READING PATHS =====
  getReadingPaths() {
    return [
      {
        id: 'youtube',
        title: 'How YouTube Works',
        desc: 'Understand how YouTube picks videos for your homepage',
        icon: '\u{1F3AC}',
        keywords: ['youtube', 'recommend', 'collaborative', 'pipeline', 'popular', 'a/b test'],
        blocks: [] // auto-populated
      },
      {
        id: 'privacy',
        title: 'Privacy & Your Data',
        desc: 'What apps know about you and how to protect yourself',
        icon: '\u{1F512}',
        keywords: ['privacy', 'data', 'footprint', 'cookie', 'tracker', 'gdpr', 'incognito'],
        blocks: []
      },
      {
        id: 'builder',
        title: 'Build Your Own RecSys',
        desc: 'Step-by-step: create a recommendation system from scratch',
        icon: '\u{1F527}',
        keywords: ['build', 'collect', 'survey', 'rating', 'similar', 'predict', 'improve', 'spreadsheet', 'code'],
        blocks: []
      },
      {
        id: 'fairness',
        title: 'Fairness & Filter Bubbles',
        desc: 'Why recommendations can be unfair and how to fix it',
        icon: '\u{2696}',
        keywords: ['fair', 'bubble', 'echo chamber', 'bias', 'diversity', 'ethical', 'addictive'],
        blocks: []
      },
      {
        id: 'algorithms',
        title: 'How Algorithms Learn',
        desc: 'The methods behind smart recommendations',
        icon: '\u{1F9E0}',
        keywords: ['collaborative filter', 'content-based', 'popular', 'pipeline', 'cold start', 'pattern'],
        blocks: []
      }
    ];
  }

  renderReadingPaths() {
    const paths = this.getReadingPaths();
    // Auto-populate blocks by matching keywords to content
    paths.forEach(path => {
      const matched = new Set();
      this.allBlocks.forEach(b => {
        const text = ((b.meta.title || '') + ' ' + (b.body || '')).toLowerCase();
        if (path.keywords.some(kw => text.includes(kw)) && b.meta.type === 'spine') {
          matched.add(b.meta.id);
        }
      });
      path.blocks = [...matched].slice(0, 8);
    });

    const activePath = this.user.activePath;
    let html = '<div class="paths-section">';
    html += '<h3 style="margin:1em 0 .5em;font-size:.95rem">Choose your reading adventure</h3>';
    html += '<p style="font-size:.8rem;color:var(--text-2);margin-bottom:1em">Pick a goal and follow a curated path through the book!</p>';

    paths.forEach(path => {
      const readCount = path.blocks.filter(id => this.user.readBlocks.has(id)).length;
      const total = path.blocks.length;
      const pct = Math.round((readCount / Math.max(total, 1)) * 100);
      const isActive = activePath === path.id;
      const isComplete = pct === 100 && total > 0;

      html += `<div class="path-card ${isActive ? 'path-active' : ''} ${isComplete ? 'path-complete' : ''}" onclick="app.selectPath('${path.id}')">
        <div class="path-icon">${path.icon}</div>
        <div class="path-info">
          <div class="path-title">${path.title}</div>
          <div class="path-desc">${path.desc}</div>
          <div class="path-progress">
            <div class="path-progress-bar"><div class="path-progress-fill" style="width:${pct}%"></div></div>
            <span class="path-progress-text">${readCount}/${total} ${isComplete ? '-- Complete!' : ''}</span>
          </div>
        </div>
        ${isActive ? '<span class="path-badge">Active</span>' : ''}
      </div>`;
    });

    // Show active path detail
    if (activePath) {
      const path = paths.find(p => p.id === activePath);
      if (path && path.blocks.length) {
        html += '<div class="path-detail">';
        html += `<h4>${path.icon} ${path.title} — Your reading list</h4>`;
        path.blocks.forEach((blockId, i) => {
          const block = this.findBlock(blockId);
          if (!block) return;
          const isRead = this.user.readBlocks.has(blockId);
          html += `<div class="path-step ${isRead ? 'path-step-done' : ''}" onclick="app.openBlock('${blockId}')">
            <span class="path-step-num">${isRead ? '\u2713' : i + 1}</span>
            <span class="path-step-title">${block.meta.title}</span>
            <span class="path-step-ch">Ch${block.meta._chapterNum}</span>
          </div>`;
        });
        html += '</div>';
      }
    }

    html += '</div>';
    return html;
  }

  selectPath(pathId) {
    this.user.activePath = this.user.activePath === pathId ? null : pathId;
    this.user.save();
    this.renderMap();
    if (this.user.activePath) {
      this.showXPToast('Path selected! Follow the steps to complete it.', 'info');
    }
  }

  _signalIcons(sig) {
    if (!sig || Object.keys(sig).length === 0) return '';
    const icons = [];
    if (sig.read) icons.push('<span class="sig-icon sig-read" title="Read">&#10003;</span>');
    else if (sig.seen) icons.push('<span class="sig-icon sig-seen" title="Seen">&#128065;</span>');
    if (sig.dwellMs > 5000) icons.push(`<span class="sig-icon sig-dwell" title="Dwell ${Math.round(sig.dwellMs/1000)}s">${Math.round(sig.dwellMs/1000)}s</span>`);
    if (sig.rated !== undefined) icons.push(sig.rated >= 0.7 ? '<span class="sig-icon sig-liked" title="Liked">&#128293;</span>' : '<span class="sig-icon sig-meh" title="Rated">&#128164;</span>');
    if (sig.saved) icons.push('<span class="sig-icon sig-saved" title="Saved">&#128278;</span>');
    if (sig.expanded) icons.push('<span class="sig-icon sig-exp" title="Expanded">&#128295;</span>');
    if (sig.noted) icons.push('<span class="sig-icon sig-note" title="Note">&#128221;</span>');
    return icons.join('');
  }

  // Show item detail inspector in map (clicked block)
  showItemDetail(blockId) {
    const block = this.findBlock(blockId);
    if (!block) return;
    const b = block.meta;
    const sig = this.user.getBlockSignals(blockId);
    const note = this.getNote(blockId);
    const isRead = this.user.readBlocks.has(blockId);
    const isSeen = this.user.seenBlocks.has(blockId);
    const isSaved = this.user.savedBlocks.has(blockId);
    const rating = this.user.ratings.get(blockId);

    const detail = document.getElementById('vmapDetail');
    if (!detail) return;

    // Build signal table
    const rows = [];
    rows.push(tr('Item ID', `<code>${blockId}</code>`));
    rows.push(tr('Type', badge(b.type, b.type === 'depth' ? b.voice : b.type)));
    rows.push(tr('Chapter', `${b._chapterNum}. ${b._chapterTitle}`));
    if (b.voice && b.voice !== 'universal') rows.push(tr('Voice', `<span class="cl-voice" style="background:var(--${b.voice})">${b.voice}</span>`));
    rows.push(tr('Reading time', `${b.readingTime || 3} min`));

    // Engagement signals
    rows.push(trHead('Collected Signals'));
    rows.push(tr('Status', isRead ? '<span style="color:var(--product);font-weight:600">&#10003; Read</span>' : isSeen ? '<span style="color:#fbbf24;font-weight:600">&#128065; Seen</span>' : '<span style="color:var(--text-3)">Not visited</span>'));
    rows.push(tr('Dwell time', sig.dwellMs ? `${Math.round(sig.dwellMs/1000)}s` : '—'));
    rows.push(tr('First seen', sig.seenAt ? new Date(sig.seenAt).toLocaleString() : '—'));
    rows.push(tr('Scroll portion', sig.portion ? `${Math.round((sig.portion||0)*100)}%` : '—'));
    rows.push(tr('Rating', rating !== undefined ? (rating >= 0.7 ? '&#128293; Great' : rating >= 0.4 ? '&#128161; Useful' : '&#128164; Known') : '—'));
    rows.push(tr('Saved', isSaved ? '&#128278; Yes' : '—'));
    rows.push(tr('Depth expanded', sig.expanded ? '&#128295; Yes' : '—'));
    rows.push(tr('Personal note', note ? `"${this.escHtml(note.substring(0,80))}${note.length>80?'...':''}"` : '—'));

    // Recombee signals
    rows.push(trHead('Sent to Recombee'));
    const rcSent = this.rc.interactions.filter(i => i.itemId === blockId);
    if (rcSent.length) {
      rcSent.forEach(i => {
        rows.push(tr(i.type, `${new Date(i.ts).toLocaleTimeString()}${i.duration ? ' ('+i.duration+'s)' : ''}`));
      });
    } else {
      rows.push(tr('—', 'No interactions sent yet'));
    }

    detail.innerHTML = `
      <div class="item-detail fade-up">
        <div class="id-head">
          <h3>${b.title}</h3>
          <button onclick="app.openBlock('${blockId}')" class="id-read-btn">Read this &rarr;</button>
        </div>
        <div class="id-teaser">${b.teaser || ''}</div>
        <table class="id-table">${rows.join('')}</table>
        <div class="id-actions">
          <button onclick="app.openBlock('${blockId}')">Open in reader</button>
          <button onclick="document.getElementById('vmapDetail').innerHTML=''">Close</button>
        </div>
      </div>`;

    detail.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    function tr(label, value) { return `<tr><td class="id-label">${label}</td><td class="id-value">${value}</td></tr>`; }
    function trHead(text) { return `<tr><td colspan="2" class="id-section">${text}</td></tr>`; }
    function badge(type, sub) {
      const colors = { spine: 'var(--text-3)', engineer: 'var(--engineer)', product: 'var(--product)', business: 'var(--business)', sidebar: 'var(--sidebar-color)' };
      return `<span style="background:${colors[sub]||colors[type]||'var(--text-3)'};color:#fff;padding:.1em .4em;border-radius:3px;font-size:.65rem;font-weight:600">${type}${sub !== type ? ' / '+sub : ''}</span>`;
    }
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

    // Level & XP hero card
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
    h += `<div class="gami-stats">
      <div class="gami-stat"><span class="gs-num">${p.progress.read}</span><span class="gs-label">Read</span></div>
      <div class="gami-stat"><span class="gs-num">${p.progress.pct}%</span><span class="gs-label">Done</span></div>
      <div class="gami-stat"><span class="gs-num">${u.achievements.length}</span><span class="gs-label">Badges</span></div>
      <div class="gami-stat"><span class="gs-num">${p.readingTimeMin}</span><span class="gs-label">Min read</span></div>
    </div>`;
    if (dueCount > 0) {
      h += `<div style="text-align:center;margin:.5em 0"><button class="recall-reveal" style="max-width:260px" onclick="app.switchView('home')">${dueCount} review${dueCount > 1 ? 's' : ''} due — go practice!</button></div>`;
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

    // Certificate
    const certReady = p.progress.pct >= 80 && u.level >= 3;
    const certLocked = !certReady;
    h += '<div class="profile-section"><h3>Certificate</h3>';
    if (certReady) {
      h += `<div class="cert-ready">
        <p style="font-size:.85rem;margin-bottom:.6em">You've completed <strong>${p.progress.pct}%</strong> of the book and reached <strong>Level ${u.level}</strong>. You've earned your certificate!</p>
        <button class="cert-btn" onclick="app.generateCertificate()">Download Certificate (PDF)</button>
      </div>`;
    } else {
      const needs = [];
      if (p.progress.pct < 80) needs.push(`read ${80 - p.progress.pct}% more content`);
      if (u.level < 3) needs.push(`reach Level 3 (need ${(3 - 1) * 50 - u.xp + 50} more XP)`);
      h += `<div class="cert-locked">
        <p style="font-size:.85rem;color:var(--text-2)">Complete the book to earn your certificate in Recommender Systems!</p>
        <div style="font-size:.8rem;color:var(--text-3);margin-top:.3em">Requirements: ${needs.join(', ')}</div>
        <div class="cert-progress">
          <div class="cert-progress-fill" style="width:${Math.min(100, Math.round((p.progress.pct / 80 + (u.level >= 3 ? 1 : u.level / 3)) / 2 * 100))}%"></div>
        </div>
      </div>`;
    }
    h += '</div>';

    // Reset
    h += '<div class="profile-section">';
    h += '<button class="btn-ghost" style="border:1px solid #dc2626;border-radius:6px;padding:.3em .8em;font-size:.75rem;color:#dc2626" onclick="app.resetAll()">Reset everything</button>';
    h += '</div>';

    el.innerHTML = h;
  }

  // ===== LINEAR DFS NAVIGATION =====
  // Build flat DFS order: Ch1 spine→depth→sidebar, Ch2 spine→depth→sidebar, ...
  getDFSOrder() {
    if (this._dfsOrder) return this._dfsOrder;
    const order = [];
    // Chapter sequence: 1, 2, 3, 4, 5, 6, 7
    for (let ci = 0; ci < this.book.chapters.length; ci++) {
      const ch = this.chapters[ci];
      if (!ch) continue;
      const spines = ch.blocks.filter(b => b.type === 'spine');
      const depths = ch.blocks.filter(b => b.type === 'depth');
      const sidebars = ch.blocks.filter(b => b.type === 'sidebar');
      const questions = ch.blocks.filter(b => b.type === 'question');
      // For each spine: spine → its depth cards → its sidebars
      spines.forEach(spine => {
        order.push({ id: spine.id, chIdx: ci, type: 'spine', title: spine.title, ch: ch.number });
        depths.filter(d => d.parent === spine.id).forEach(d => {
          order.push({ id: d.id, chIdx: ci, type: 'depth', title: d.title, voice: d.voice, ch: ch.number, parent: spine.id });
        });
        sidebars.filter(s => s.parent === spine.id).forEach(s => {
          order.push({ id: s.id, chIdx: ci, type: 'sidebar', title: s.title, ch: ch.number, parent: spine.id });
        });
      });
      // Questions at end of chapter
      questions.forEach(q => {
        order.push({ id: q.id, chIdx: ci, type: 'question', title: q.title, ch: ch.number });
      });
    }
    this._dfsOrder = order;
    return order;
  }

  getCurrentDFSIndex() {
    const order = this.getDFSOrder();
    const current = this.user.currentBlock;
    if (!current) return 0;
    const idx = order.findIndex(n => n.id === current);
    return idx >= 0 ? idx : 0;
  }

  linearPrev() {
    const order = this.getDFSOrder();
    let idx = this.getCurrentDFSIndex() - 1;
    if (idx < 0) idx = 0;
    const node = order[idx];
    this.user.currentBlock = node.id;
    this.user.save();
    // Navigate to the block (spine directly, depth/sidebar via parent)
    const targetId = node.parent || node.id;
    this.openBlock(targetId);
    this.updateLinearNav();
  }

  linearNext() {
    const order = this.getDFSOrder();
    let idx = this.getCurrentDFSIndex() + 1;
    if (idx >= order.length) idx = order.length - 1;
    const node = order[idx];
    this.user.currentBlock = node.id;
    this.user.save();
    const targetId = node.parent || node.id;
    this.openBlock(targetId);
    this.updateLinearNav();
  }

  updateLinearNav() {
    const nav = document.getElementById('linearNav');
    if (!nav) return;
    const order = this.getDFSOrder();
    const idx = this.getCurrentDFSIndex();
    const current = order[idx];
    const prev = order[idx - 1];
    const next = order[idx + 1];

    document.getElementById('lnPrev').disabled = !prev;
    document.getElementById('lnNext').disabled = !next;

    const pct = Math.round(((idx + 1) / order.length) * 100);
    const info = document.getElementById('lnInfo');
    if (info) {
      info.innerHTML = `<span style="color:var(--accent);font-weight:600">${idx + 1}</span>/${order.length} &middot; Ch${current?.ch || '?'}: ${(current?.title || '').substring(0, 40)}`;
    }
  }

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
          explorer: { label: 'See it in action', blocks: ['ch1-everywhere-d-exp', 'ch2-track-d-exp'] },
          creator: { label: 'Build something', blocks: ['ch1-first-d-create'] },
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
          thinker: { label: 'Think about privacy', blocks: ['ch2-privacy-d-think'] }
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
          creator: { label: 'Pop your bubble', blocks: ['ch4-pop-d-create', 'ch4-experiment'] },
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
          thinker: { label: 'The big questions', blocks: ['ch6-goals-d-think', 'ch6-hard-d-think', 'ch6-law-sidebar'] }
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

  _isMissionComplete(mission) {
    const p = this._getMissionProgress(mission);
    return p.read >= mission.core.length; // core blocks must all be read
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

  // ===== CHAT =====
  toggleMobileChat() {
    const panel = document.getElementById('chatPanelMobile');
    if (!panel) return;
    panel.classList.toggle('open');
    if (panel.classList.contains('open')) document.getElementById('chatInputMobile')?.focus();
  }

  sendMobileChat() {
    const input = document.getElementById('chatInputMobile');
    const msg = input?.value?.trim();
    if (!msg) return;
    input.value = '';
    const messages = document.getElementById('chatMessagesMobile');
    if (!messages) return;
    messages.innerHTML += `<div class="chat-msg user">${this.escHtml(msg)}</div>`;
    const response = this.generateChatResponse(msg);
    setTimeout(() => { messages.innerHTML += `<div class="chat-msg bot">${response}</div>`; messages.scrollTop = messages.scrollHeight; }, 300);
    messages.scrollTop = messages.scrollHeight;
  }

  sendChat() {
    const input = document.getElementById('chatInput');
    const msg = input?.value?.trim();
    if (!msg) return;
    input.value = '';
    const messages = document.getElementById('chatMessages');
    if (!messages) return;
    messages.innerHTML += `<div class="chat-msg user">${this.escHtml(msg)}</div>`;
    const response = this.generateChatResponse(msg);
    setTimeout(() => { messages.innerHTML += `<div class="chat-msg bot">${response}</div>`; messages.scrollTop = messages.scrollHeight; }, 300);
    messages.scrollTop = messages.scrollHeight;
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
    const results = await this.rc.searchItems(query, 15);
    if (!results?.recomms?.length) { el.innerHTML = '<div class="search-empty">No results found.</div>'; return; }
    el.innerHTML = results.recomms.map(r => {
      const b = this.findBlock(r.id);
      const meta = b?.meta || r.values || {};
      const badge = meta.voice && meta.voice !== 'universal' ? `<span class="card-badge ${meta.voice}">${CONFIG.voices[meta.voice]?.label || meta.voice}</span>` : '';
      return `<div class="card" style="margin-bottom:.5em" onclick="app.openBlock('${r.id}');app.closeSearch()"><div class="card-chapter">${meta._chapterTitle || ''}</div><div class="card-title">${meta.title || r.id}</div><div class="card-meta">${badge}<span class="card-time">${meta.readingTime || 3} min</span></div></div>`;
    }).join('');
  }

  // ===== INTERACTIONS =====
  toggleDepth(blockId, parentId, voice) {
    const container = document.querySelector(`.depth-group[data-parent="${parentId}"]`);
    if (!container) return;
    const card = document.getElementById(`dc-${blockId}`);
    const tab = container.querySelector(`.d-tab[data-voice="${voice}"]`);
    const wasActive = card?.classList.contains('active');
    container.querySelectorAll('.d-tab').forEach(t => t.classList.remove('active'));
    container.querySelectorAll('.d-content').forEach(c => c.classList.remove('active'));
    if (!wasActive && card && tab) {
      tab.classList.add('active');
      card.classList.add('active');
      this.user.trackVoiceExpand(voice, blockId);
      this.rc.sendCartAdd(blockId);
      this.showXPToast('+5 XP', 'xp');
      this.checkGamificationEvents(); // Strong positive signal
      this.renderMath(card); // Render math in newly revealed depth card
    }
  }

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

  feedBlock(blockId, rating) {
    this.rc.sendRating(blockId, rating);
    this.user.trackRating(blockId, rating);
  }

  saveBlock(blockId) {
    this.user.trackSave(blockId);
    this.rc.sendBookmark(blockId);
    if (!this.user.seenBlocks.has(blockId)) this.user.trackSeen(blockId);
    const btn = document.querySelector(`#b-${blockId} .act-btn[title="Save"]`);
    if (btn) btn.classList.add('active');
  }

  saveCurrent() { if (this.user.currentBlock) this.saveBlock(this.user.currentBlock); }
  rateCurrent(r) { if (this.user.currentBlock) this.feedBlock(this.user.currentBlock, r); }

  revealVoice(voice, chapterIdx) {
    this.user.voiceScores[voice] = Math.max(this.user.voiceScores[voice], 1);
    this.user.save();
    this.renderRead(chapterIdx);
  }

  openBlock(blockId) {
    const block = this.findBlock(blockId);
    if (!block) return;
    const chIdx = block.meta._chapterIdx;
    const parentId = block.meta.parent || blockId; // depth cards → scroll to parent
    this.user.currentBlock = blockId;
    this.user.currentChapter = chIdx;
    this.user.save();

    // If already viewing this chapter, just scroll
    if (this.currentView === 'read' && this._renderedChapter === chIdx) {
      this._scrollToBlock(parentId, block.meta);
      this._updateMissionBar();
      return;
    }

    this._pendingScroll = { parentId, meta: block.meta };
    this.switchView('read');
    this.renderRead(chIdx);
  }

  // Show/hide mission indicator in topbar
  _updateMissionBar() {
    const container = document.getElementById('missionBarInline');
    const m = this._wizardMission;
    if (!container) return;
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

  _scrollToBlock(parentId, meta) {
    setTimeout(() => {
      const el = document.getElementById(`b-${parentId}`);
      if (!el) return;

      if (meta.type === 'depth' && meta.voice) {
        // For depth cards: first expand the tab, then scroll to the depth content
        const tab = document.querySelector(`.depth-group[data-parent="${parentId}"] .d-tab[data-voice="${meta.voice}"]`);
        if (tab && !tab.classList.contains('active')) tab.click();
        // Scroll to the expanded depth card content, not the parent spine
        setTimeout(() => {
          const depthContent = document.getElementById(`dc-${meta.id}`);
          if (depthContent) depthContent.scrollIntoView({ behavior: 'smooth', block: 'start' });
          else el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 200);
      } else if (meta.type === 'sidebar') {
        // For sidebars: scroll to the sidebar block itself
        // Sidebars don't have unique IDs in DOM, scroll to parent
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } else {
        // Spine blocks: scroll directly
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }, 150);
  }

  goChapter(idx) {
    this.user.currentChapter = idx;
    this.user.save();
    this.switchView('read');
    this.renderRead(idx);
  }

  // ===== SETTINGS =====
  toggleSettings() {
    document.getElementById('settingsDrawer').classList.toggle('open');
  }

  setTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme === 'light' ? '' : theme);
    localStorage.setItem('pbook-theme', theme);
    this.updateSettingsUI();
  }

  setFontSize(size) {
    const map = { small: '1rem', medium: '1.125rem', large: '1.25rem' };
    document.documentElement.style.setProperty('--fs', map[size]);
    localStorage.setItem('pbook-fs', size);
    this.updateSettingsUI();
  }

  applyTheme() {
    const theme = localStorage.getItem('pbook-theme');
    if (theme && theme !== 'light') document.documentElement.setAttribute('data-theme', theme);
    const fs = localStorage.getItem('pbook-fs');
    if (fs) { const map = { small: '1rem', medium: '1.125rem', large: '1.25rem' }; document.documentElement.style.setProperty('--fs', map[fs]); }
    this.updateSettingsUI();
  }

  updateSettingsUI() {
    document.querySelectorAll('.sg-opt').forEach(o => o.classList.remove('active'));
    const theme = localStorage.getItem('pbook-theme') || 'light';
    const fs = localStorage.getItem('pbook-fs') || 'medium';
    document.querySelector(`.sg-opt[data-theme="${theme}"]`)?.classList.add('active');
    document.querySelector(`.sg-opt[data-fs="${fs}"]`)?.classList.add('active');
    document.getElementById('recStatus').textContent = this.rc.enabled ? `Connected: ${this.rc.config.database}` : 'Demo mode (local simulation)';
  }

  cycleVoice() {
    const voices = ['universal', ...Object.keys(CONFIG.voices)];
    const current = this.user.preferredVoice || 'universal';
    const next = voices[(voices.indexOf(current) + 1) % voices.length];
    this.user.setVoice(next);
    if (this.rc.enabled) this.rc.setUserProperties({ voice: next });
    this.updateVoiceBadge();
    // Re-render current view to reflect voice change
    if (this.currentView === 'read') this.renderRead();
    else if (this.currentView === 'home') this.renderHome();
  }

  updateXPBadge() {
    const el = document.getElementById('xpBadge');
    if (!el) return;
    el.textContent = 'Lv.' + this.user.level + ' · ' + this.user.xp + 'XP';
  }

  showXPToast(text, type) {
    const toast = document.getElementById('xpToast');
    if (!toast) return;
    toast.textContent = text;
    toast.className = 'xp-toast ' + (type || 'xp') + ' show';
    clearTimeout(this._xpToastTimer);
    this._xpToastTimer = setTimeout(() => { toast.classList.remove('show'); }, 2500);
  }

  // Check for pending gamification events and show toasts
  checkGamificationEvents() {
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

  exportProfile() {
    const profile = this.user.getProfile(this.allBlocks);
    const interactions = this.rc.interactions;
    const notes = JSON.parse(localStorage.getItem('pbook-notes') || '{}');
    const data = { profile, interactions, notes, exportedAt: new Date().toISOString() };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `pbook-profile-${profile.userId.substring(0, 8)}.json`;
    a.click();
  }

  generateCertificate() {
    const u = this.user;
    const p = u.getProfile(this.allBlocks);
    const date = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    const uid = (localStorage.getItem('pbook-uid') || 'reader').substring(0, 12);

    // Award certificate achievement
    if (!u.achievements.find(a => a.id === 'certified')) {
      u.achievements.push({ id: 'certified', name: 'Certified!', icon: '\u{1F393}', desc: 'Earned your certificate', earnedAt: Date.now() });
      u.addXP(50);
      u.save();
      this.showXPToast('+50 XP \u{1F393} Certificate earned!', 'achievement');
    }

    // Generate SVG certificate
    const topVoice = u.getTopVoice();
    const voiceLabel = CONFIG.voices[topVoice]?.label || 'Universal';
    const svg = `<?xml version="1.0" encoding="UTF-8"?>
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
  <text x="400" y="245" text-anchor="middle" font-family="Georgia,serif" font-size="24" fill="#1C1917">Reader ${uid}</text>
  <line x1="250" y1="255" x2="550" y2="255" stroke="#D4B5FD" stroke-width="1"/>

  <!-- Achievement stats -->
  <text x="400" y="290" text-anchor="middle" font-family="system-ui,sans-serif" font-size="12" fill="#6B7280">has successfully completed the study of Modern Recommender Systems</text>

  <text x="200" y="330" text-anchor="middle" font-family="system-ui,sans-serif" font-size="11" fill="#7C3AED" font-weight="600">${p.progress.read} sections read</text>
  <text x="400" y="330" text-anchor="middle" font-family="system-ui,sans-serif" font-size="11" fill="#7C3AED" font-weight="600">Level ${u.level} \u2022 ${u.xp} XP</text>
  <text x="600" y="330" text-anchor="middle" font-family="system-ui,sans-serif" font-size="11" fill="#7C3AED" font-weight="600">${u.achievements.length} badges earned</text>

  <text x="200" y="355" text-anchor="middle" font-family="system-ui,sans-serif" font-size="10" fill="#9CA3AF">${p.progress.pct}% complete</text>
  <text x="400" y="355" text-anchor="middle" font-family="system-ui,sans-serif" font-size="10" fill="#9CA3AF">${voiceLabel} path</text>
  <text x="600" y="355" text-anchor="middle" font-family="system-ui,sans-serif" font-size="10" fill="#9CA3AF">${p.readingTimeMin} min reading</text>

  <!-- Specialization -->
  <rect x="280" y="375" width="240" height="30" rx="15" fill="#7C3AED" opacity=".1"/>
  <text x="400" y="395" text-anchor="middle" font-family="system-ui,sans-serif" font-size="12" fill="#7C3AED" font-weight="600">Specialization: ${voiceLabel}</text>

  <!-- Topics -->
  <text x="400" y="435" text-anchor="middle" font-family="system-ui,sans-serif" font-size="10" fill="#9CA3AF">Key topics: ${(p.topTopics || []).slice(0, 4).join(' \u2022 ') || 'Recommender Systems'}</text>

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

    // Download as SVG (can be opened/printed from browser)
    const blob = new Blob([svg], { type: 'image/svg+xml' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `recsys-certificate-${uid}.svg`;
    a.click();
    URL.revokeObjectURL(a.href);
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

// Text highlight on selection
document.addEventListener('mouseup', () => {
  const popup = document.getElementById('highlightPopup');
  if (!popup) return;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.toString().trim()) { popup.style.display = 'none'; return; }
  // Only in read view, inside spine-body
  const anchor = sel.anchorNode?.parentElement?.closest('.spine-body, .d-content, .sb-block');
  if (!anchor) { popup.style.display = 'none'; return; }
  const range = sel.getRangeAt(0);
  const rect = range.getBoundingClientRect();
  popup.style.display = 'flex';
  popup.style.top = (rect.top + window.scrollY - 40) + 'px';
  popup.style.left = (rect.left + rect.width / 2 - 40) + 'px';
});

// Keyboard: arrows for chapter nav in read view
document.addEventListener('keydown', e => {
  if (app.currentView !== 'read' || !app.book) return;
  if (e.key === 'ArrowRight' && app.user.currentChapter < app.book.chapters.length - 1) app.goChapter(app.user.currentChapter + 1);
  if (e.key === 'ArrowLeft' && app.user.currentChapter > 0) app.goChapter(app.user.currentChapter - 1);
});
