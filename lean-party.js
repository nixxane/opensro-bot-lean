// Approve only correlated applications to the local player's matching listing.
const Party = {
  answered: '',
  registration: null,
  lastRegisterAt: -Infinity,
  message: 'Auto-recruit off.',
  joinMessage: '', joinedKey: '', lastPageAt: -Infinity, lastJoinAt: -Infinity, scanDoneAt: -Infinity, wantPage: 1,
  reset() {
    this.answered = ''; this.registration = null; this.lastRegisterAt = -Infinity; this.message = 'Waiting for party state.';
    this.joinMessage = ''; this.joinedKey = ''; this.lastPageAt = this.lastJoinAt = this.scanDoneAt = -Infinity; this.wantPage = 1;
  },
  // Comma or line separated character names; empty means everyone.
  names(text) { return String(text || '').split(/[,;\n]/).map(n => n.trim().toLowerCase()).filter(Boolean); },
  listed(name) { const list = this.names(Settings.profile.party.acceptNames); return !list.length || list.includes(String(name || '').trim().toLowerCase()); },
  leaderName(social) { return social.members.find(m => m && m.id === social.leader)?.name || ''; },
  // Alt accounts, optional: leave a party whose leader is not the named party leader once that character is back at the
  // hunting spot (the join below then looks for their party). While they are away, after a disconnect say, the party the
  // game handed to another member stays together.
  leaveWrongParty() {
    const c = Settings.profile.party, leader = String(c.mainName || '').trim().toLowerCase(), social = World.gp?.social;
    if (!c.joinMain || !c.leaveIfNotLeader || !leader || !social || !Array.isArray(social.members) || social.members.length < 2 || !social.leader) return;
    const name = this.leaderName(social).toLowerCase();
    if (!name || name === leader || String(social.localName || '').toLowerCase() === leader) return;
    if (!this.leaderBack(leader) || now() - this.lastLeaveAt < 10000 || !Cmd.spaced('party-leave')) return;
    if (Cmd.raw({ kind: 'party-leave' }, 'Leave the party of ' + this.leaderName(social) + ' (leader is not ' + c.mainName.trim() + ')')) {
      this.lastLeaveAt = now(); this.joinedKey = '';
      UI.toast('Left the party: its leader is not ' + c.mainName.trim(), 'info', 3000);
    }
  },
  lastLeaveAt: -Infinity,
  // The named party leader is in view and, with a saved hunting spot, within 30 m of the hunting area.
  leaderBack(name) {
    const H = Hunt.cfg();
    return [...World.ents.values()].some(e => e.kind === 'player' && String(e.name || '').trim().toLowerCase() === name && (!H.center || dist2D(e, H.center) <= H.radius + 300));
  },
  // Alt accounts: find the main account's party and join it. A party invitation from the main is accepted; otherwise the
  // party-matching board is paged for the main's listing and the bot applies to it (the main's Auto-recruit and
  // Auto-accept answer). Runs only while solo, so it never pulls the character out of another party.
  joinMain() {
    const c = Settings.profile.party, main = String(c.mainName || '').trim().toLowerCase();
    if (!c.joinMain || !main) { this.joinMessage = ''; return; }
    const gp = World.gp, social = gp?.social, matching = gp?.partyMatching, me = String(social?.localName || '').toLowerCase();
    if (!social || !matching || !Array.isArray(social.members)) { this.joinMessage = 'Waiting for party state.'; return; }
    if (me && me === main) { this.joinMessage = 'This is the main account; nothing to join.'; return; }
    const named = m => String(m?.name || '').toLowerCase();
    if (social.members.some(m => named(m) === main)) { this.joinMessage = 'In ' + c.mainName.trim() + "'s party."; this.joinedKey = ''; this.wantPage = 1; return; }
    if (social.members.some(m => m && named(m) !== me)) {
      this.joinMessage = c.leaveIfNotLeader ? 'In another party; leaving it once ' + c.mainName.trim() + ' is back at the hunting spot.' : 'In another party; leave it to join ' + c.mainName.trim() + '.';
      return;
    }
    const inv = social.invitation;
    if (inv && (inv.type === 2 || inv.type === 3) && String(World.ents.get(inv.gid)?.name || '').toLowerCase() === main) {
      const key = inv.type + ':' + inv.gid;
      if (key !== this.joinedKey && Cmd.spaced('social-consent') && Cmd.raw({ kind: 'social-consent', accept: true }, 'Accept party invitation from ' + c.mainName.trim())) this.joinedKey = key;
      this.joinMessage = 'Accepting the invitation from ' + c.mainName.trim() + '.'; return;
    }
    // An application the main never answered (it handles one at a time, so a second alt can be dropped) must not wait
    // forever: after 30 seconds the application is made again.
    const stale = this.lastJoinAt > -Infinity && now() - this.lastJoinAt > 30000;
    if ((matching.pending || matching.joining) && !stale) { this.joinMessage = 'Waiting for the party board…'; return; }
    const level = World.gp?.progression?.level, row = (matching.rows || []).find(r => named(r) === main);
    if (row) {
      const full = row.members >= ((row.type & 1) ? 8 : 4);
      if (full) { this.joinMessage = c.mainName.trim() + "'s party is full."; return; }
      if (Number.isInteger(level) && (level < row.min || level > row.max)) { this.joinMessage = 'Level ' + level + ' is outside ' + c.mainName.trim() + "'s listing (" + row.min + '-' + row.max + ').'; return; }
      if (now() - this.lastJoinAt < 20000 || !Cmd.spaced('party-match-join')) { this.joinMessage = 'Applied to ' + c.mainName.trim() + "'s party; waiting for the answer."; return; }
      // The board is a copy of the last page read, and the main's listing gets a new number each time it is registered
      // again (after a disconnect, or when the party broke up). An application to the old number never reaches the main,
      // so the page is read again before every new application.
      if (this.lastJoinAt > this.lastPageAt) {
        if (Cmd.spaced('party-match-page') && Cmd.raw({ kind: 'party-match-page', page: matching.page || 1 }, 'Read ' + c.mainName.trim() + "'s party listing again")) {
          this.lastPageAt = now(); this.wantPage = 1; this.scanDoneAt = -Infinity;
        }
        this.joinMessage = 'Checking ' + c.mainName.trim() + "'s party listing again."; return;
      }
      if (Cmd.raw({ kind: 'party-match-join', id: row.id }, 'Join ' + c.mainName.trim() + "'s party")) this.lastJoinAt = now();
      this.joinMessage = 'Applying to ' + c.mainName.trim() + "'s party."; return;
    }
    // Not on the page we have: walk the board a page at a time, then rest before scanning again.
    const pages = matching.pages || 0;
    if (this.wantPage > Math.max(pages, 1)) this.wantPage = 1, this.scanDoneAt = now();
    if (now() - this.scanDoneAt < 20000) { this.joinMessage = 'No listing from ' + c.mainName.trim() + ' yet; is Auto-recruit on for that account?'; return; }
    if (now() - this.lastPageAt < 2500 || !Cmd.spaced('party-match-page')) return;
    if (Cmd.raw({ kind: 'party-match-page', page: this.wantPage }, 'Look for ' + c.mainName.trim() + "'s party listing")) { this.lastPageAt = now(); this.wantPage++; }
    this.joinMessage = 'Looking for ' + c.mainName.trim() + "'s party listing…";
  },
  // Party sharing options: the party's own once formed, else the listing's, else the saved new-party choice.
  options(matching, social) {
    const c = Settings.profile.party;
    return social.leader ? social.options : matching.own?.type ?? ((c.expShare ? 1 : 0) | (c.itemShare ? 2 : 0));
  },
  recruit(matching, social) {
    const c = Settings.profile.party;
    if (!c.autoRecruit) { this.message = 'Auto-recruit off.'; return; }
    if (matching.own) {
      this.registration = null;
      this.message = social.leader && social.self !== social.leader ? 'Listing present; only the leader can auto-accept.' : social.members.length >= (((social.leader ? social.options : matching.own.type) & 1) ? 8 : 4) ? 'Party full; waiting for a free slot.' : 'Listing active; accepting applicants when space is available.';
      return;
    }
    if (this.registration) {
      if (now() - this.registration.at < 15000) { this.message = 'Waiting for registration confirmation.'; return; }
      // A local send can be refused before registration starts. Retry only
      // after a newer native snapshot explicitly confirms no listing or request.
      if (World.gp === this.registration.state) { this.message = 'Registration unconfirmed; waiting for fresh party state before retrying.'; return; }
      if (matching.own !== null || matching.pending !== null || matching.request || matching.joining) {
        this.message = 'Waiting for party matching before retrying registration.'; return;
      }
      this.registration = null;
    }
    if (matching.own !== null || matching.pending !== null || matching.request || matching.joining) { this.message = 'Waiting for party matching.'; return; }
    if (social.leader && (!social.self || social.self !== social.leader) || !social.leader && social.members.length) {
      this.message = 'Waiting until you are solo or party leader.'; return;
    }
    const type = social.leader ? social.options : (c.expShare ? 1 : 0) | (c.itemShare ? 2 : 0);
    if (!Number.isInteger(type) || type < 0 || type > 7) { this.message = 'Waiting for party options.'; return; }
    if (social.members.length >= ((type & 1) ? 8 : 4)) { this.message = 'Party full; waiting for a free slot.'; return; }
    if (!social.leader && !(World.gp?.progression?.level >= 5)) { this.message = 'Level 5 is required to form a listing.'; return; }
    const title = String(c.title || '').trim();
    if (!title || title.length > 50 || !Number.isInteger(c.min) || !Number.isInteger(c.max) || c.min < 1 || c.max > 90 || c.min > c.max) {
      this.message = 'Set a title (1-50 characters) and a level range within 1-90.'; return;
    }
    // Match the client party-matching purpose matrix for the equipped job suit.
    const flags = World.gp.inventory?.find(i => i.slot === 8)?.typeFlags ?? 0, suit = flags >>> 11;
    const job = (flags & 0x7fe) === 0x3ac && suit >= 1 && suit <= 3 ? suit : 4;
    const validPurpose = Number.isInteger(c.purpose) && (job === 1 || job === 3 ? c.purpose === 2 : job === 2 ? c.purpose === 3 : c.purpose >= 0 && c.purpose < 2);
    if (!validPurpose) { this.message = 'Listing purpose does not match your equipped job suit.'; return; }
    if (now() - this.lastRegisterAt < 30000 || !Cmd.spaced('party-match-register')) { this.message = 'Waiting before restoring the listing.'; return; }
    const registration = { party: 0, type, purpose: c.purpose, min: c.min, max: c.max, title };
    if (Cmd.raw({ kind: 'party-match-register', registration }, 'Auto-recruit: register party listing')) {
      this.registration = { at: now(), state: World.gp }; this.lastRegisterAt = now();
      this.message = 'Waiting for registration confirmation.';
    }
  },
  // Hunting at the moment of death is remembered, so a resurrection accepted within 15 minutes resumes it whatever the
  // "On death" setting did. A revive the player or the bot does itself never resumes anything.
  huntAtDeath: null, resumeHunt: null, consentAt: -Infinity, aliveSince: 0,
  noteDeath() { if (Hunt.running && !this.huntAtDeath) this.huntAtDeath = { at: now() }; },
  // Another party member who is alive (status & 15 is their health in tenths, 0 when dead) and in view might resurrect us.
  helperNearby() {
    const social = World.gp?.social;
    return !!social?.members?.some(m => m && m.name && m.name !== social.localName && (m.status & 15) !== 0 &&
      [...World.ents.values()].some(e => e.kind === 'player' && e.name === m.name && e.appearanceState?.[0] !== 2));
  },
  helperSeenAt: -Infinity,
  // With Accept resurrection on and a helper at hand, wait longer before the bot revives itself. A helper seen in the
  // last 15 seconds still counts, so a moment out of view or a death far from the party does not cut the wait short.
  helping() {
    if (this.helperNearby()) this.helperSeenAt = now();
    return now() - this.helperSeenAt < 15000;
  },
  reviveDelay() {
    const wait = Math.min(600, Math.max(5, Number(Settings.profile.party.reviveWaitS) || 20)) * 1000;
    return Settings.profile.party.acceptRes && this.helping() ? wait : 5000;
  },
  // One plain sentence for the log when the character dies.
  waitNote() {
    if (!Settings.profile.party.acceptRes) return 'reviving in 5 s (Accept resurrection from party members is off).';
    const wait = this.reviveDelay();
    return wait > 5000 ? `waiting ${Math.round(wait / 1000)} s for a party member to resurrect before reviving.` : 'no party member in view, reviving in 5 s.';
  },
  // Never revive while an offer is open or an acceptance was just sent.
  resBusy() { return !!World.gp?.social?.resurrection || now() - this.consentAt < 4000; },
  resumeTick() {
    const r = this.resumeHunt;
    if (this.huntAtDeath && now() - this.huntAtDeath.at > 15 * 60000) this.huntAtDeath = null;
    if (!World.inWorld() || World.isDead()) { this.aliveSince = 0; return; }
    if (!this.aliveSince) this.aliveSince = now();
    if (!r) {
      // Alive without an accepted resurrection: the memory belongs to a death that is over.
      if (this.huntAtDeath && now() - this.aliveSince > 10000) this.huntAtDeath = null;
      return;
    }
    if (Hunt.running) { this.resumeHunt = this.huntAtDeath = null; return; }
    if (now() - r.at > 120000) { this.resumeHunt = this.huntAtDeath = null; return; }
    if (now() - this.aliveSince < 2000 || !World.local() || World.gp?.inventoryPending) return;
    this.resumeHunt = this.huntAtDeath = null;
    Controller.resumeHunting('Resurrected');
  },
  // A dead character gets a Yes/No resurrection question from a caster's Rebirth skill. Only party members
  // are answered, and only while dead; other questions (including mutation proposals) are left to the player.
  acceptResurrection() {
    const c = Settings.profile.party, social = World.gp?.social, question = social?.resurrection;
    if (!c.acceptRes || !question || question.mutation || !World.inWorld() || !World.isDead() || !Array.isArray(social.members)) return;
    const caster = World.ents.get(question.gid);
    if (!caster?.name || !social.members.some(m => m?.name === caster.name && m.name !== social.localName)) return;
    if (!Cmd.spaced('resurrection-consent')) return;
    if (Cmd.raw({ kind: 'resurrection-consent', accept: true }, 'Accept resurrection from ' + caster.name)) {
      this.consentAt = now();
      this.resumeHunt = this.huntAtDeath && !Hunt.running && now() - this.huntAtDeath.at < 15 * 60000 ? { at: now() } : null;
      UI.toast('Accepted resurrection from ' + caster.name, 'info', 3000);
    }
  },
  tick() {
    this.acceptResurrection();
    if (World.inWorld() && Settings.profile.party.acceptRes) this.helping();
    const c = Settings.profile.party;
    if (World.inWorld()) { this.leaveWrongParty(); this.joinMain(); } else this.joinMessage = '';
    if (!World.inWorld() || (!c.autoAcceptMatching && !c.autoRecruit)) return;
    const gp = World.gp, matching = gp?.partyMatching, request = matching?.request, social = gp?.social;
    if (!matching || !social || !Array.isArray(social.members)) return;
    this.recruit(matching, social);
    if (!request) { this.answered = ''; return; }
    if (!social || !Array.isArray(social.members)) return;
    // An owned listing can exist before the first applicant forms the party.
    // The game only routes applications to the listing's owner, and the local listing record can be
    // missing while the server's still exists (it is wiped on world entry and after a party dissolves),
    // so a live application is enough; the leader, capacity and deadline checks below still apply.
    if (social.leader && (!social.self || social.self !== social.leader)) return;
    if (!social.leader && social.members.length) return;
    const options = this.options(matching, social);
    if (!Number.isInteger(options) || social.members.length >= ((options & 1) ? 8 : 4)) return;
    const sim = World.simNow();
    if (!Number.isFinite(sim) || !Number.isFinite(request.expires) || sim >= request.expires) return;
    if (![request.a, request.b].every(id => Number.isInteger(id) && id > 0 && id <= 0xffffffff)) return;
    const key = `${request.a}:${request.b}:${request.expires}`;
    // A name list narrows who is accepted; an applicant outside it is left unanswered for the player.
    if (!this.listed(request.member?.name)) { this.message = 'Applicant ' + (request.member?.name || '?') + ' is not on the accept list.'; return; }
    if (key === this.answered || !Cmd.spaced('party-match-answer')) return;
    // Same correlation and accept value as the game's matching approval button.
    if (Cmd.raw({ kind: 'party-match-answer', a: request.a, b: request.b, answer: 1 }, 'Auto-accept party-matching application')) {
      this.answered = key;
      UI.toast('Party join acceptance sent: ' + (request.member?.name || 'Applicant'), 'info', 3000);
    }
  },
};
// Hits by party members, and by their pets, do not make a monster "another player's target": hunting together is the
// point of a party, and No-KS would otherwise skip every monster the party is already fighting.
{
  const record = World.onCast;
  World.onCast = function (cast) {
    const social = this.gp?.social, caster = this.ents.get(cast.caster);
    const owner = caster?.kind === 'cos' ? this.ents.get(caster.ownerGid) : caster;
    const name = owner?.name || (caster?.kind === 'cos' ? caster.ownerName : '');
    const member = !!name && Array.isArray(social?.members) && name !== social.localName && social.members.some(m => m?.name === name);
    if (!member) return record.call(this, cast);
    const targets = new Set([cast.target, ...(cast.results || []).map(r => r?.target)].filter(Boolean));
    const before = new Map([...targets].map(gid => [gid, this.hitByOthers.get(gid)]));
    try { return record.call(this, cast); }
    finally { for (const [gid, at] of before) at === undefined ? this.hitByOthers.delete(gid) : this.hitByOthers.set(gid, at); }
  };
}
