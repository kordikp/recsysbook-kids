// Recombee client for p-book — production version
// Handles: HMAC auth, user identity, interactions, recommendations, search
// Falls back to local simulation when API unavailable

import { CONFIG } from './config.js';

export class RecombeeClient {
  constructor() {
    this.config = { ...CONFIG.recombee };
    // Disable on localhost (no proxy available)
    const isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    this.enabled = this.config.enabled && !isLocal;
    this.userId = this.getOrCreateUserId();
    this.interactions = []; // local log (always kept for offline reference)
    this.allBlocks = [];
  }

  // --- User identity (persistent across sessions) ---
  getOrCreateUserId() {
    let id = localStorage.getItem('pbook-uid');
    if (!id) {
      id = 'reader-' + crypto.randomUUID();
      localStorage.setItem('pbook-uid', id);
    }
    return id;
  }

  setAllBlocks(blocks) { this.allBlocks = blocks; }


  // --- API call via server-side proxy (avoids CORS) ---
  async api(method, endpoint, body) {
    if (!this.enabled) return null;
    try {
      const res = await fetch('/.netlify/functions/recombee', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint, body })
      });
      if (res.ok) return await res.json();
      // Any error → silently switch to local mode
      this.enabled = false;
      return null;
    } catch (e) {
      this.enabled = false;
      return null;
    }
  }

  // --- Interactions (always stored locally + sent to Recombee) ---
  async sendView(itemId, duration) {
    const i = { type: 'detailview', itemId, userId: this.userId, ts: Date.now(), duration };
    this.interactions.push(i);
    this._saveInteractions();
    const body = { userId: this.userId, itemId, cascadeCreate: true, timestamp: new Date().toISOString() };
    if (duration) body.duration = duration;
    if (this._lastRecommId) body.recommId = this._lastRecommId;
    if (this.enabled) return this.api('POST', '/detailviews/', body);
  }

  async sendRating(itemId, rating) {
    const i = { type: 'rating', itemId, userId: this.userId, ts: Date.now(), rating };
    this.interactions.push(i);
    this._saveInteractions();
    if (this.enabled) return this.api('POST', '/ratings/', {
      userId: this.userId, itemId, rating,
      cascadeCreate: true, timestamp: new Date().toISOString()
    });
  }

  async sendBookmark(itemId) {
    const i = { type: 'bookmark', itemId, userId: this.userId, ts: Date.now() };
    this.interactions.push(i);
    this._saveInteractions();
    if (this.enabled) return this.api('POST', '/bookmarks/', {
      userId: this.userId, itemId,
      cascadeCreate: true, timestamp: new Date().toISOString()
    });
  }

  async sendCartAdd(itemId) {
    const i = { type: 'cartaddition', itemId, userId: this.userId, ts: Date.now() };
    this.interactions.push(i);
    this._saveInteractions();
    if (this.enabled) return this.api('POST', '/cartadditions/', {
      userId: this.userId, itemId,
      cascadeCreate: true, timestamp: new Date().toISOString()
    });
  }

  async setUserProperties(props) {
    if (this.enabled) {
      return this.api('POST', `/users/${this.userId}`, { ...props, cascadeCreate: true });
    }
  }

  // --- Persist interactions locally ---
  _saveInteractions() {
    try {
      // Keep last 500 interactions
      const recent = this.interactions.slice(-500);
      localStorage.setItem('pbook-interactions', JSON.stringify(recent));
    } catch (e) {}
  }

  _loadInteractions() {
    try {
      const saved = JSON.parse(localStorage.getItem('pbook-interactions') || '[]');
      this.interactions = saved;
    } catch (e) {}
  }

  // --- ReQL helpers ---
  reql(filters = {}) {
    const parts = [];
    if (filters.type) parts.push(`'type' == "${filters.type}"`);
    if (filters.voice) parts.push(`'voice' in {${filters.voice.map(v => `"${v}"`).join(',')}}`);
    if (filters.chapter) parts.push(`'chapter' == "${filters.chapter}"`);
    if (filters.standalone) parts.push(`'standalone' == true`);
    if (filters.maxTime) parts.push(`'readingTime' <= ${filters.maxTime}`);
    return parts.length ? parts.join(' AND ') : undefined;
  }

  reqlBoost(userModel) {
    const parts = [];
    const pref = userModel.voiceScores;
    if (pref) {
      const top = Object.entries(pref).sort((a, b) => b[1] - a[1])[0];
      if (top && top[1] > 3) parts.push(`if 'voice' == "${top[0]}" then 1.5`);
    }
    return parts.length ? parts.join(' AND ') : undefined;
  }

  // --- Recommendations (Recombee API with local fallback) ---
  async getRecsForUser(scenario, count, filter, booster) {
    if (this.enabled) {
      const body = { count, cascadeCreate: true };
      if (scenario) body.scenario = scenario;
      if (filter) body.filter = filter;
      if (booster) body.booster = booster;
      const result = await this.api('POST', `/recomms/users/${this.userId}/items/`, body);
      if (result) {
        if (result.recommId) this._lastRecommId = result.recommId;
        return result;
      }
    }
    return this._localRecsForUser(scenario, count);
  }

  async getRecsForItem(itemId, count, filter) {
    if (this.enabled) {
      const body = { count, targetUserId: this.userId, cascadeCreate: true };
      if (filter) body.filter = filter;
      const result = await this.api('POST', `/recomms/items/${itemId}/items/`, body);
      if (result) {
        if (result.recommId) this._lastRecommId = result.recommId;
        return result;
      }
    }
    return this._localRecsForItem(itemId, count);
  }

  async searchItems(query, count, filter) {
    if (this.enabled) {
      const body = { searchQuery: query, count, cascadeCreate: true };
      if (filter) body.filter = filter;
      const result = await this.api('POST', `/search/users/${this.userId}/items/`, body);
      if (result) return result;
    }
    return this._localSearch(query, count);
  }

  // --- Local fallback recommendations ---
  _viewed() { return new Set(this.interactions.filter(i => i.type === 'detail-view').map(i => i.itemId)); }

  _localRecsForUser(scenario, count) {
    const viewed = this._viewed();
    let pool = this.allBlocks.filter(b => !viewed.has(b.meta.id));
    if (scenario === 'pbook:spine') pool = pool.filter(b => b.meta.type === 'spine');
    if (scenario === 'pbook:popular') pool = this.allBlocks.filter(b => b.meta.standalone);
    pool = pool.sort(() => Math.random() - 0.5);
    return { recomms: pool.slice(0, count).map(b => ({ id: b.meta.id, values: b.meta })) };
  }

  _localRecsForItem(itemId, count) {
    const block = this.allBlocks.find(b => b.meta.id === itemId);
    if (!block) return { recomms: [] };
    const ch = block.meta.chapter || block._chapter;
    let pool = this.allBlocks.filter(b => b.meta.id !== itemId && (b.meta.chapter === ch || b._chapter === ch));
    if (pool.length < count) pool = [...pool, ...this.allBlocks.filter(b => b.meta.id !== itemId)];
    return { recomms: pool.sort(() => Math.random() - 0.5).slice(0, count).map(b => ({ id: b.meta.id, values: b.meta })) };
  }

  _localSearch(query, count) {
    const q = query.toLowerCase();
    const scored = this.allBlocks.map(b => {
      let score = 0;
      const title = (b.meta.title || '').toLowerCase();
      const body = (b.body || '').toLowerCase();
      if (title.includes(q)) score += 10;
      for (const word of q.split(/\s+/)) {
        if (word.length < 3) continue;
        if (title.includes(word)) score += 3;
        if (body.includes(word)) score += 1;
      }
      return { block: b, score };
    }).filter(s => s.score > 0).sort((a, b) => b.score - a.score);
    return { recomms: scored.slice(0, count).map(s => ({ id: s.block.meta.id, values: s.block.meta })) };
  }

  // --- Status ---
  getStatus() {
    return {
      mode: this.enabled ? 'live' : 'local',
      database: this.config.database,
      region: this.config.region,
      userId: this.userId,
      interactions: this.interactions.length,
      apiCalls: this._apiCalls || 0
    };
  }
}

// --- User Model (engagement tracking + profile) ---
export class UserModel {
  constructor() {
    this.voiceScores = { explorer: 0, creator: 0, thinker: 0 };
    this.readBlocks = new Set();
    this.seenBlocks = new Set();
    this.savedBlocks = new Set();
    this.ratings = new Map();
    this.notes = new Set();
    this.signals = {};
    this.totalInteractions = 0;
    this.currentChapter = 0;
    this.currentBlock = null;
    this.preferredVoice = null;
    this.firstVisit = null;
    this.sessionCount = 0;
    // Gamification (no streaks — safe for kids)
    this.xp = 0;
    this.level = 1;
    this.achievements = [];
    // Spaced repetition recall (Anki-style)
    this.recall = {}; // blockId → { interval, ease, nextReview, lastReview, reps }
    this.activePath = null; // current reading path id
    this.completedMissions = [];
    this.missionTitles = [];
    this.missionBranches = {};
    this.load();
    this._trackSession();
  }

  _trackSession() {
    if (!this.firstVisit) this.firstVisit = Date.now();
    this.sessionCount++;
    this.lastVisit = Date.now();
    this.save();
  }

  load() {
    try {
      const s = JSON.parse(localStorage.getItem('pbook-user') || '{}');
      if (s.voiceScores) this.voiceScores = s.voiceScores;
      if (s.readBlocks) this.readBlocks = new Set(s.readBlocks);
      if (s.seenBlocks) this.seenBlocks = new Set(s.seenBlocks);
      if (s.savedBlocks) this.savedBlocks = new Set(s.savedBlocks);
      if (s.ratings) this.ratings = new Map(s.ratings);
      if (s.notes) this.notes = new Set(s.notes);
      if (s.signals) this.signals = s.signals;
      if (s.totalInteractions) this.totalInteractions = s.totalInteractions;
      if (s.currentChapter !== undefined) this.currentChapter = s.currentChapter;
      if (s.currentBlock) this.currentBlock = s.currentBlock;
      if (s.preferredVoice) this.preferredVoice = s.preferredVoice;
      if (s.firstVisit) this.firstVisit = s.firstVisit;
      if (s.sessionCount) this.sessionCount = s.sessionCount;
      if (s.xp) this.xp = s.xp;
      if (s.level) this.level = s.level;
      if (s.achievements) this.achievements = s.achievements;
      if (s.recall) this.recall = s.recall;
      if (s.activePath) this.activePath = s.activePath;
      if (s.completedMissions) this.completedMissions = s.completedMissions;
      if (s.missionTitles) this.missionTitles = s.missionTitles;
      if (s.missionBranches) this.missionBranches = s.missionBranches;
    } catch (e) {}
  }

  save() {
    try {
      localStorage.setItem('pbook-user', JSON.stringify({
        voiceScores: this.voiceScores,
        readBlocks: [...this.readBlocks],
        seenBlocks: [...this.seenBlocks],
        savedBlocks: [...this.savedBlocks],
        ratings: [...this.ratings],
        notes: [...this.notes],
        signals: this.signals,
        totalInteractions: this.totalInteractions,
        currentChapter: this.currentChapter,
        currentBlock: this.currentBlock,
        preferredVoice: this.preferredVoice,
        firstVisit: this.firstVisit,
        sessionCount: this.sessionCount,
        xp: this.xp,
        level: this.level,
        achievements: this.achievements,
        recall: this.recall,
        activePath: this.activePath,
        completedMissions: this.completedMissions,
        missionTitles: this.missionTitles,
        missionBranches: this.missionBranches,
      }));
    } catch (e) {}
  }

  _sig(id) { if (!this.signals[id]) this.signals[id] = {}; return this.signals[id]; }

  trackSeen(blockId) {
    this.seenBlocks.add(blockId);
    const s = this._sig(blockId);
    s.seen = true;
    s.seenAt = Date.now();
    this.save();
  }

  trackRead(blockId) {
    this.readBlocks.add(blockId);
    this.seenBlocks.add(blockId);
    this._sig(blockId).read = true;
    this.totalInteractions++;
    this.addXP(10, 'Read a section');
    this.scheduleRecall(blockId);
    this.checkAchievements();
    this.save();
  }

  trackDwell(blockId, ms) {
    const s = this._sig(blockId);
    s.dwellMs = (s.dwellMs || 0) + ms;
    this.save();
  }

  trackPortion(blockId, portion) {
    const s = this._sig(blockId);
    s.portion = Math.max(s.portion || 0, portion);
    this.save();
  }

  trackVoiceExpand(voice, blockId) {
    if (voice && this.voiceScores[voice] !== undefined) {
      this.voiceScores[voice]++;
      this.totalInteractions++;
      if (blockId) this._sig(blockId).expanded = true;
      this.addXP(5);
      this.checkAchievements();
      this.save();
    }
  }

  trackRating(blockId, rating) {
    this.ratings.set(blockId, rating);
    this._sig(blockId).rated = rating;
    this.addXP(3);
    this.save();
  }

  trackSave(blockId) {
    this.savedBlocks.add(blockId);
    this._sig(blockId).saved = true;
    this.addXP(2);
    this.save();
  }

  trackNote(blockId) {
    this.notes.add(blockId);
    this._sig(blockId).noted = true;
    this.addXP(5);
    this.save();
  }

  setVoice(voice) { this.preferredVoice = voice; this.save(); }

  getBlockSignals(blockId) { return this.signals[blockId] || {}; }

  // --- Spaced repetition (Anki-style) ---
  // Schedule a block for recall after it's read
  scheduleRecall(blockId) {
    if (this.recall[blockId]) return; // already scheduled
    this.recall[blockId] = {
      interval: 1,       // days until next review (starts at 1 day)
      ease: 2.5,         // ease factor (Anki default)
      nextReview: Date.now() + 24 * 60 * 60 * 1000, // 1 day from now
      lastReview: Date.now(),
      reps: 0
    };
    this.save();
  }

  // Process a recall response: quality 0-3 (forgot, hard, good, easy)
  processRecall(blockId, quality) {
    const card = this.recall[blockId];
    if (!card) return;

    card.reps++;
    card.lastReview = Date.now();

    if (quality < 1) {
      // Forgot — reset to 1 day
      card.interval = 1;
      card.ease = Math.max(1.3, card.ease - 0.2);
    } else if (quality === 1) {
      // Hard — small increase
      card.interval = Math.max(1, Math.round(card.interval * 1.2));
      card.ease = Math.max(1.3, card.ease - 0.15);
    } else if (quality === 2) {
      // Good — normal increase
      card.interval = Math.round(card.interval * card.ease);
    } else {
      // Easy — big increase
      card.interval = Math.round(card.interval * card.ease * 1.3);
      card.ease = Math.min(3.0, card.ease + 0.15);
    }

    // Cap at 30 days for kids (don't want reviews too far apart)
    card.interval = Math.min(30, card.interval);
    card.nextReview = Date.now() + card.interval * 24 * 60 * 60 * 1000;

    // XP reward based on quality
    const xpReward = quality >= 2 ? 8 : quality === 1 ? 5 : 2;
    this.addXP(xpReward);
    this.checkAchievements();
    this.save();
    return xpReward;
  }

  // Get blocks that are due for review
  getDueRecalls() {
    const now = Date.now();
    return Object.entries(this.recall)
      .filter(([_, card]) => card.nextReview <= now)
      .sort((a, b) => a[1].nextReview - b[1].nextReview)
      .map(([blockId, card]) => ({ blockId, ...card }));
  }

  // --- Gamification ---
  addXP(amount) {
    this.xp += amount;
    const newLevel = Math.floor(this.xp / 50) + 1;
    if (newLevel > this.level) { this.level = newLevel; this._pendingLevelUp = newLevel; }
  }

  checkAchievements() {
    const earned = new Set(this.achievements.map(a => a.id));
    const checks = [
      { id: 'first_read', name: 'First Steps', icon: '👣', desc: 'Read your first section', test: () => this.readBlocks.size >= 1 },
      { id: 'reader_5', name: 'Bookworm', icon: '📚', desc: 'Read 5 sections', test: () => this.readBlocks.size >= 5 },
      { id: 'reader_15', name: 'Speed Reader', icon: '⚡', desc: 'Read 15 sections', test: () => this.readBlocks.size >= 15 },
      { id: 'reader_30', name: 'Knowledge Machine', icon: '🤖', desc: 'Read 30 sections', test: () => this.readBlocks.size >= 30 },
      { id: 'first_like', name: 'Thumbs Up', icon: '❤️', desc: 'Like your first section', test: () => [...this.ratings.values()].some(r => r >= 0.7) },
      { id: 'like_10', name: 'Super Fan', icon: '🌟', desc: 'Like 10 sections', test: () => [...this.ratings.values()].filter(r => r >= 0.7).length >= 10 },
      { id: 'first_note', name: 'Note Taker', icon: '📝', desc: 'Write your first note', test: () => this.notes.size >= 1 },
      { id: 'voice_all', name: 'Triple Threat', icon: '🎭', desc: 'Try all 3 depth voices', test: () => Object.values(this.voiceScores).every(v => v > 0) },
      { id: 'curious_cat', name: 'Curious Cat', icon: '🐱', desc: 'Read sections from 3 different chapters', test: () => { const chs = new Set(); this.readBlocks.forEach(id => { for (const [k,v] of Object.entries(this.signals)) { if (k === id) chs.add(v.chapter || ''); }}); return chs.size >= 3 || this.readBlocks.size >= 12; }},
      { id: 'quiz_master', name: 'Quiz Master', icon: '🧩', desc: 'Answer 3 questions', test: () => this.totalInteractions >= 15 },
      { id: 'level_5', name: 'Level 5!', icon: '🏆', desc: 'Reach level 5', test: () => this.level >= 5 },
      { id: 'save_5', name: 'Collector', icon: '🔖', desc: 'Save 5 sections', test: () => this.savedBlocks.size >= 5 },
      { id: 'xp_200', name: 'XP Hunter', icon: '💎', desc: 'Earn 200 XP', test: () => this.xp >= 200 },
      { id: 'deep_diver', name: 'Deep Diver', icon: '🤿', desc: 'Expand 10 depth cards', test: () => Object.values(this.voiceScores).reduce((s,v) => s+v, 0) >= 10 },
      { id: 'recall_5', name: 'Memory Pro', icon: '🧠', desc: 'Complete 5 recall reviews', test: () => Object.values(this.recall).reduce((s, c) => s + c.reps, 0) >= 5 },
    ];
    checks.forEach(a => {
      if (!earned.has(a.id) && a.test()) {
        this.achievements.push({ id: a.id, name: a.name, icon: a.icon, desc: a.desc, earnedAt: Date.now() });
        this._pendingAchievement = a;
      }
    });
  }

  getLevelTitle() {
    const titles = ['Newbie', 'Curious', 'Apprentice', 'Explorer', 'Scholar', 'Expert', 'Wizard', 'Legend', 'Grandmaster', 'Recommendation Guru'];
    return titles[Math.min(this.level - 1, titles.length - 1)];
  }

  getXPForNextLevel() { return this.level * 50; }
  getXPInCurrentLevel() { return this.xp - (this.level - 1) * 50; }

  getVisibleVoices() {
    const allVoices = Object.keys(this.voiceScores);
    const total = Object.values(this.voiceScores).reduce((s, v) => s + v, 0);
    if (total < 5) return allVoices;
    if (this.preferredVoice && this.preferredVoice !== 'universal') {
      const visible = [this.preferredVoice];
      for (const [v, score] of Object.entries(this.voiceScores)) {
        if (v !== this.preferredVoice && score / total > 0.2) visible.push(v);
      }
      return visible;
    }
    return Object.entries(this.voiceScores)
      .filter(([_, score]) => score / total > 0.1)
      .map(([v]) => v)
      .concat(total < 10 ? allVoices : [])
      .filter((v, i, a) => a.indexOf(v) === i);
  }

  getTopVoice() {
    if (this.preferredVoice && this.preferredVoice !== 'universal') return this.preferredVoice;
    const entries = Object.entries(this.voiceScores).sort((a, b) => b[1] - a[1]);
    return entries[0] && entries[0][1] > 0 ? entries[0][0] : null;
  }

  getProgress(allBlocks) {
    const spineBlocks = allBlocks.filter(b => b.meta.type === 'spine');
    const read = spineBlocks.filter(b => this.readBlocks.has(b.meta.id));
    const seen = spineBlocks.filter(b => this.seenBlocks.has(b.meta.id));
    return {
      read: read.length, seen: seen.length, total: spineBlocks.length,
      pct: Math.round((read.length / Math.max(spineBlocks.length, 1)) * 100)
    };
  }

  getSignalSummary() {
    let views = 0, reads = 0, dwellTotal = 0, ratings = 0, saves = 0, notes = 0, expands = 0;
    Object.values(this.signals).forEach(s => {
      if (s.seen) views++;
      if (s.read) reads++;
      if (s.dwellMs) dwellTotal += s.dwellMs;
      if (s.rated !== undefined) ratings++;
      if (s.saved) saves++;
      if (s.noted) notes++;
      if (s.expanded) expands++;
    });
    return { views, reads, dwellTotal, ratings, saves, notes, expands };
  }

  // --- Reader profile summary ---
  getProfile(allBlocks) {
    const prog = this.getProgress(allBlocks);
    const summary = this.getSignalSummary();
    const totalVoice = Object.values(this.voiceScores).reduce((s, v) => s + v, 0) || 1;

    // Top topics from read blocks
    const topicCounts = {};
    [...this.readBlocks].forEach(id => {
      const block = allBlocks.find(b => b.meta.id === id);
      if (!block) return;
      const body = ((block.meta.title || '') + ' ' + (block.body || '')).toLowerCase();
      const topics = {
        'Collaborative Filtering': ['collaborative filter'],
        'Deep Learning': ['deep learn', 'neural', 'transformer'],
        'Cold Start': ['cold start', 'cold-start'],
        'Evaluation': ['a/b test', 'evaluation', 'metric', 'ndcg'],
        'Search': ['search', 'query', 'retrieval'],
        'Objectives': ['objective', 'stakeholder', 'alignment'],
        'Data': ['interaction data', 'item catalog', 'feedback'],
      };
      for (const [topic, kws] of Object.entries(topics)) {
        if (kws.some(k => body.includes(k))) topicCounts[topic] = (topicCounts[topic] || 0) + 1;
      }
    });
    const topTopics = Object.entries(topicCounts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([t]) => t);

    // Liked blocks
    const liked = [...this.ratings].filter(([_, r]) => r >= 0.7).map(([id]) => {
      const b = allBlocks.find(x => x.meta.id === id);
      return b ? b.meta.title : null;
    }).filter(Boolean);

    return {
      userId: localStorage.getItem('pbook-uid'),
      firstVisit: this.firstVisit ? new Date(this.firstVisit).toLocaleDateString() : null,
      sessions: this.sessionCount,
      totalInteractions: this.totalInteractions,
      progress: prog,
      signals: summary,
      voicePreference: Object.fromEntries(
        Object.entries(this.voiceScores).map(([v, s]) => [v, Math.round((s / totalVoice) * 100)])
      ),
      topTopics,
      liked,
      savedCount: this.savedBlocks.size,
      notesCount: this.notes.size,
      readingTimeMin: Math.round(summary.dwellTotal / 60000),
    };
  }

  reset() {
    this.voiceScores = { explorer: 0, creator: 0, thinker: 0 };
    this.readBlocks = new Set();
    this.seenBlocks = new Set();
    this.savedBlocks = new Set();
    this.ratings = new Map();
    this.notes = new Set();
    this.signals = {};
    this.totalInteractions = 0;
    this.currentChapter = 0;
    this.currentBlock = null;
    this.preferredVoice = null;
    this.firstVisit = Date.now();
    this.sessionCount = 0;
    this.xp = 0;
    this.level = 1;
    this.achievements = [];
    this.recall = {};
    this.activePath = null;
    this.completedMissions = [];
    this.missionTitles = [];
    this.missionBranches = {};
    this.save();
  }
}
