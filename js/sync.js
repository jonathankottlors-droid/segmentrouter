// Wahoo-Live-Segment-Sync: hält die Zahl gesternter Segmente unter dem Limit (Wahoo zieht ~100).
import { Store } from './store.js';
import { StarService, StravaError } from './strava.js';

export class LiveSegmentSync {
  constructor() {
    const p = Store.get('livesync', { appStars: [], protected: [], limit: 80 });
    this.limit = p.limit || 80;
    this.appStars = Object.fromEntries((p.appStars || []).map(s => [s.id, s]));
    this.protected = new Set(p.protected || []);
    this.currentStarred = [];
    this.starredLoadedAt = null;
    this.progress = null; this.progressLabel = '';
    this.onStarChanged = null; this.onProgress = null;
  }
  get isRunning() { return this.progress != null; }
  persist() { Store.set('livesync', { limit: this.limit, appStars: Object.values(this.appStars), protected: [...this.protected] }); }
  setLimit(n) { this.limit = n; this.persist(); }
  setProtected(id, on) { on ? this.protected.add(id) : this.protected.delete(id); this.persist(); }

  async refreshStarred() {
    const list = await StarService.loadAllStarred();
    this.currentStarred = list.map(s => ({ id: s.id, name: s.name, distance: s.distance, appStarredAt: this.appStars[s.id]?.starredAt ?? null }));
    this.starredLoadedAt = Date.now();
  }

  /// Dry-Run: a) Sterne laden b) toStar c) bei Überschreitung entsternen: App-Sterne (älteste zuerst), dann fremde – nie geschützt/geplant.
  async plan(planned, refresh = true) {
    if (refresh || !this.starredLoadedAt) await this.refreshStarred();
    const starred = new Set(this.currentStarred.map(s => s.id)), plannedIds = new Set(planned.map(p => p.id));
    const seen = new Set(); const unique = planned.filter(p => !seen.has(p.id) && seen.add(p.id));
    const plan = { toStar: [], toUnstar: [], alreadyStarred: unique.filter(p => starred.has(p.id)), overLimit: [], currentCount: this.currentStarred.length, limit: this.limit };
    let toStar = unique.filter(p => !starred.has(p.id));
    const over = this.currentStarred.length + toStar.length - this.limit;
    if (over > 0) {
      const cands = this.currentStarred.filter(s => !plannedIds.has(s.id) && !this.protected.has(s.id)).sort((a, b) => {
        if (a.appStarredAt && b.appStarredAt) return a.appStarredAt - b.appStarredAt;
        if (a.appStarredAt) return -1; if (b.appStarredAt) return 1; return a.name.localeCompare(b.name);
      });
      plan.toUnstar = cands.slice(0, over);
      const still = over - plan.toUnstar.length;
      if (still > 0) { plan.overLimit = toStar.slice(-still); toStar = toStar.slice(0, -still); }
    }
    plan.toStar = toStar;
    plan.afterCount = plan.currentCount - plan.toUnstar.length + plan.toStar.length;
    plan.isEmpty = !plan.toStar.length && !plan.toUnstar.length;
    return plan;
  }

  async execute(plan) {
    const result = { starred: [], unstarred: [], skipped: [...plan.alreadyStarred, ...plan.overLimit], errors: [], rateLimited: false };
    const total = plan.toUnstar.length + plan.toStar.length;
    this.progress = { done: 0, total };
    const tick = label => { this.progressLabel = label; this.onProgress?.(); };
    outer: for (const [on, items] of [[false, plan.toUnstar], [true, plan.toStar]]) {
      for (const item of items) {
        tick(`${on ? 'Sterne' : 'Entsterne'} „${item.name}“`);
        try {
          await StarService.setStarred(item.id, on);
          if (on) { this.appStars[item.id] = { id: item.id, starredAt: Date.now(), name: item.name }; result.starred.push(item); this.currentStarred.push({ ...item, appStarredAt: Date.now() }); }
          else { delete this.appStars[item.id]; result.unstarred.push(item); this.currentStarred = this.currentStarred.filter(s => s.id !== item.id); }
          this.onStarChanged?.(item.id, on);
        } catch (e) {
          if (e instanceof StravaError && e.rateLimited) { result.rateLimited = true; break outer; }
          result.errors.push({ item, message: e.message });
        }
        this.progress = { done: this.progress.done + 1, total }; this.onProgress?.();
      }
    }
    this.persist(); this.progress = null; this.progressLabel = ''; this.onProgress?.();
    return result;
  }

  async unstarAllAppStars() {
    const items = Object.values(this.appStars).filter(s => !this.protected.has(s.id)).sort((a, b) => a.starredAt - b.starredAt).map(s => ({ id: s.id, name: s.name, distance: 0, appStarredAt: s.starredAt }));
    return this.execute({ toStar: [], toUnstar: items, alreadyStarred: [], overLimit: [] });
  }
}
