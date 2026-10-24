/*
===========================================================================
lean-logging.js - bounded activity events and local diagnostic capture

Normal activity and command traces have separate retention. Events describe
observed evidence; an operation ID never implies a server transaction ID.
===========================================================================
*/
const ACTIVITY_LIMIT = { normal: 400, commands: 1000, text: 1000, repeatMs: 1000, captureMs: 600000 };
const ACTIVITY_CATEGORIES = [ "session", "combat", "movement", "town", "stall", "potion", "loot", "party", "buff", "alchemy", "reconnect", "settings", "engine", "assets" ];
const ACTIVITY_DETAIL_KEYS = [ "durationMs", "distance", "attempt", "quantity", "hpPct", "mpPct", "delayMs", "choice", "errorCode", "goldChange", "kills", "deaths", "potions", "items", "revision", "visited", "progressAgeMs", "monsterId", "skillId", "attackingPlayer", "leg", "legs" ];
const Activity = {
	commands: [], revision: 0, sequence: 0, session: 0, operation: 0, captureUntil: 0,
	filters: { category: "all", level: "all", search: "", detailed: false },
	contexts: {}, states: new Map(), pendingPotions: new Map(), potionCount: 0, potionSummaryAt: 0,

	/*
	================
	category
	Legacy callers keep working while owners migrate to explicit event codes.
	================
	*/
	category( text ) {
		for ( const [ category, pattern ] of [
			[ "alchemy", /alchemy|fusion|elixir|stone fused|destroyed at/i ],
			[ "reconnect", /reconnect|connection lost|login is gone/i ],
			[ "town", /town|warehouse|merchant|repair|reverse|scroll arrival|ammunition/i ],
			[ "buff", /buff gear|buff set|combat gear|buff swap/i ],
			[ "potion", /potion|recovery kit|pet hp/i ],
			[ "loot", /loot|pickup|drop disappeared|collected|sox found/i ],
			[ "party", /party|resurrect|rebirth/i ],
			[ "movement", /move|walking|walk-back|obstacle|trapped|escape|stuck/i ],
			[ "combat", /attack|target|skill refused|rotation/i ],
			[ "assets", /icon|catalogue|map tile|wardrobe/i ],
			[ "session", /hunting started|hunting stopped|bot ready|died:/i ]
		] ) if ( pattern.test( text ) ) return category;
		return "engine";
	},

	/*
	================
	emit
	Logging must not interrupt gameplay or consume confirmation state.
	================
	*/
	emit( event ) {
		try {
			const text = String( event.text || event.code || "Activity" ).slice( 0, ACTIVITY_LIMIT.text );
			const level = [ "info", "warn", "error", "cmd" ].includes( event.level ) ? event.level : "info";
			const category = ACTIVITY_CATEGORIES.includes( event.category ) ? event.category : this.category( text );
			if ( level === "cmd" && now() >= this.captureUntil ) return null;
			const details = {};
			for ( const key of ACTIVITY_DETAIL_KEYS ) {
				const value = event.details?.[key];
				if ( typeof value === "number" && Number.isFinite( value ) || typeof value === "boolean" ) details[key] = value;
			}
			if ( [ "attackers", "nearest", "lowhp" ].includes( event.details?.selectionPolicy ) ) details.selectionPolicy = event.details.selectionPolicy;
			const entry = { id: ++this.sequence, at: Date.now(), mono: now(), lastAt: Date.now(),
				level, category, code: /^[a-z0-9-]{1,64}$/.test( event.code || "" ) ? event.code : "legacy-message",
				text, outcome: [ "requested", "confirmed", "refused", "unconfirmed", "cancelled", "waiting", "summary" ].includes( event.outcome ) ? event.outcome : null,
				sessionId: this.session, epoch: Number.isSafeInteger( World.epoch ) ? World.epoch : null,
				operationId: Number.isSafeInteger( event.operationId ) ? event.operationId : null, details, repeatCount: 1 };
			entry.userText = event.userText ? String( event.userText ).slice( 0, ACTIVITY_LIMIT.text ) : null;
			if ( event.failure && this.safeFailure ) entry.failure = this.safeFailure( event.failure );
			if ( entry.code === "target-selected" ) {
				const name = World.ents.get( details.monsterId )?.name || "a monster";
				entry.userText = "Targeting " + name + (details.attackingPlayer ? " — it’s attacking you." : ".");
			}
			if ( entry.code === "approach-abandoned" ) {
				entry.userText = "Couldn’t reach " + (World.ents.get( details.monsterId )?.name || "the monster") + "; looking for another target.";
			}
			if ( entry.userText ) entry.userText = entry.userText.slice( 0, ACTIVITY_LIMIT.text );
			const rows = event.diagnosticOnly ? this.refusals : level === "cmd" ? this.commands : Log.lines;
			const previous = rows[rows.length - 1];
			if ( previous && previous.code === entry.code && previous.text === text && previous.level === level &&
				previous.category === category && previous.userText === entry.userText && previous.operationId === entry.operationId && previous.sessionId === entry.sessionId &&
				previous.epoch === entry.epoch && previous.outcome === entry.outcome &&
				JSON.stringify( previous.failure ) === JSON.stringify( entry.failure ) &&
				JSON.stringify( previous.details ) === JSON.stringify( details ) && entry.mono - previous.lastMono < ACTIVITY_LIMIT.repeatMs ) {
				previous.repeatCount++;
				previous.lastAt = entry.at;
				previous.lastMono = entry.mono;
				this.revision++;
				return previous;
			}
			entry.lastMono = entry.mono;
			rows.push( entry );
			const limit = event.diagnosticOnly ? 400 : level === "cmd" ? ACTIVITY_LIMIT.commands : ACTIVITY_LIMIT.normal;
			if ( rows.length > limit ) rows.splice( 0, rows.length - limit );
			this.revision++;
			bus.emit( "log", entry );
			return entry;
		} catch { return null; }
	},

	/*
	================
	begin / end
	================
	*/
	begin( category, text ) {
		const id = ++this.operation;
		this.contexts[category] = { id, at: now(), gold: Stats.integer( World.gp?.progression?.gold ) };
		this.emit( { category, code: "operation-start", text, outcome: "requested", operationId: id } );
		return id;
	},
	end( category, text, outcome = "confirmed" ) {
		const context = this.contexts[category];
		if ( !context ) return;
		const gold = Stats.integer( World.gp?.progression?.gold );
		const change = gold !== null && context.gold !== null ? Number( gold - context.gold ) : undefined;
		this.emit( { category, code: "operation-end", text, outcome, operationId: context.id,
			details: { durationMs: now() - context.at, goldChange: Number.isSafeInteger( change ) ? change : undefined } } );
		delete this.contexts[category];
	},

	/*
	================
	transition
	Only changed states are activity, not every controller tick.
	================
	*/
	transition( category, code, text, outcome = "waiting", details = {} ) {
		const key = category + ":" + code;
		const identity = JSON.stringify( [ text, World.epoch, this.contexts[category]?.id ] );
		if ( this.states.get( key ) === identity ) return;
		this.states.set( key, identity );
		if ( this.states.size > 100 ) this.states.delete( this.states.keys().next().value );
		this.emit( { category, code, text, outcome, details, operationId: this.contexts[category]?.id } );
	},

	/*
	================
	capture / visible / clear
	================
	*/
	capture( enabled ) {
		this.captureUntil = enabled ? now() + ACTIVITY_LIMIT.captureMs : 0;
		this.filters.detailed = enabled;
		this.emit( { category: "settings", code: "capture-changed", text: enabled ? "Detailed command capture enabled for 10 minutes; kept locally." : "Detailed command capture stopped." } );
	},
	visible( exporting = false ) {
		const search = this.filters.search.toLowerCase();
		return [ ...Log.lines, ...(this.filters.detailed ? this.commands : []), ...this.refusals ].sort( ( a, b ) => a.id - b.id ).filter( entry =>
			(exporting && entry.failure) || (this.filters.category === "all" || entry.category === this.filters.category) &&
			(this.filters.level === "all" || entry.level === this.filters.level) &&
			(!search || (this.userMessage( entry ) + " " + entry.text + " " + entry.code).toLowerCase().includes( search )) );
	},
	clear() {
		Log.lines.length = 0;
		this.commands.length = 0;
		this.refusals.length = 0; this.refusalGroups.clear();
		this.revision++;
	},

	/*
	================
	observePotions / flushPotions
	Inventory evidence remains separate from the stats owner's counters.
	================
	*/
	observePotions() {
		if ( !World.inWorld() || World.gp?.inventoryPending ) return;
		for ( const [ ref, pending ] of this.pendingPotions ) {
			if ( pending.epoch !== World.epoch ) { this.pendingPotions.delete( ref ); continue; }
			const total = Stats.total( ref ), used = Math.min( pending.count, Math.max( 0, pending.before - total ) );
			if ( used ) {
				this.potionCount += used;
				this.emit( { category: "potion", level: "cmd", code: "potion-consumed", outcome: "confirmed",
					text: "Potion inventory decrease observed after a use request.", details: { ...pending.details, quantity: used } } );
				pending.count -= used; pending.before = total;
				if ( !pending.count ) this.pendingPotions.delete( ref );
			}
			if ( pending.count && now() - pending.at >= 15000 ) {
				this.emit( { category: "potion", code: "potion-unconfirmed", level: "warn", outcome: "unconfirmed", text: "Potion consumption was not confirmed; a late result is still possible." } );
				this.pendingPotions.delete( ref );
			}
		}
		if ( this.potionCount && now() - this.potionSummaryAt >= 30000 ) this.flushPotions();
	},
	flushPotions() {
		if ( !this.potionCount ) return;
		this.emit( { category: "potion", code: "potion-summary", outcome: "summary", text: this.potionCount + " potion consumptions observed since the previous summary.", details: { quantity: this.potionCount } } );
		this.potionCount = 0; this.potionSummaryAt = now();
	},

	/*
	================
	export
	Standard export excludes names, free text, player identities and locations.
	Monster/skill IDs and selection enums provide non-personal diagnostic context.
	Raw local export is a separate explicit preview choice, never an upload.
	================
	*/
	export( raw = false, format = "json" ) {
		const events = this.visible( true ).map( entry => ( { id: entry.id, at: entry.at, lastAt: entry.lastAt,
			level: entry.level, category: entry.category, code: entry.code, outcome: entry.outcome,
			sessionId: entry.sessionId, epoch: entry.epoch, operationId: entry.operationId,
			repeatCount: entry.repeatCount, details: entry.details, ...(entry.failure ? { failure: entry.failure, failureSamples: entry.failureSamples || [] } : {}), ...(raw ? { text: entry.text, userMessage: this.userMessage( entry ) } : {}) } ) );
		if ( format === "text" ) return events.map( entry => new Date( entry.at ).toISOString() + " [" + entry.level + "] [" + entry.category + "] " +
			(entry.outcome || "event") + " " + entry.code + " ×" + entry.repeatCount + (raw ? ": " + entry.text : "") + " " + JSON.stringify( entry.details ) + (entry.failure ? " " + JSON.stringify( { failure: entry.failure, failureSamples: entry.failureSamples || [] } ) : "") ).join( "\n" );
		return JSON.stringify( { version: VERSION, schema: 3, distanceUnits: "game units (10 per metre)", raw, events }, null, 2 );
	},

	/*
	================
	wrap
	Observe successful function returns without changing their result or errors.
	================
	*/
	wrap( owner, name, observe ) {
		const original = owner[name];
		owner[name] = function( ...args ) {
			const result = original.apply( this, args );
			try { observe.call( this, result, ...args ); } catch {}
			return result;
		};
	}
};

/*
================
Log compatibility and shared events
================
*/
Log.command = function( command, text ) {
	const owner = Town.trip ? "town" : /alchemy/.test( command.kind ) ? "alchemy" :
		/pickup/.test( command.kind ) ? "loot" : command.kind === "item-use" ? "potion" :
		command.kind === "move" || WalkBack.active || Chase.s || Trap.run ? "movement" : "combat";
	return Activity.emit( { level: "cmd", category: owner, code: "command-" + command.kind, text,
		outcome: "requested", operationId: Activity.contexts[owner]?.id } );
};
Log.add = function( level, text ) {
	return Activity.emit( { level, text, outcome: level === "cmd" ? "requested" : null } );
};
bus.on( "game-error", text => {
	Activity.refusal( text );
} );
bus.on( "hunt", running => {
	if ( running ) {
		Activity.session++;
		Activity.emit( { category: "session", code: "session-start", text: "Session " + Activity.session + " started; bot " + VERSION + ".", outcome: "confirmed" } );
	} else {
		Activity.observePotions(); Activity.flushPotions();
		Activity.emit( { category: "session", code: "session-summary", text: "Session paused; totals retained.", outcome: "summary", details: Stats.session } );
	}
} );
bus.on( "character", name => {
	if ( Activity.character === name ) return;
	Activity.character = name;
	Activity.pendingPotions.clear();
	Activity.flushPotions();
	Activity.states.clear();
	Activity.contexts = {};
	Activity.emit( { category: "session", code: "character-boundary", text: "Character loaded; subsequent activity belongs to this character." } );
} );
Activity.wrap( Alchemy, "note", function( result, text ) {
	Activity.emit( { category: "alchemy", code: "alchemy-result", text,
		level: /destroyed/i.test( text ) ? "error" : "info", outcome: /^(Success:|Failed at|Destroyed at)|stone (failed|fused)|→/.test( text ) ? "confirmed" : null } );
} );
Activity.wrap( Town, "begin", function() {
	if ( this.trip ) {
		Activity.begin( "town", "Town trip started: " + this.trip.why + "." );
		Activity.transition( "town", "trip-phase", "Town phase: " + this.trip.phase, "waiting", { choice: this.trip.reverseChoice } );
	}
} );
Activity.wrap( Town, "enter", function( result, phase ) {
	Activity.transition( "town", "trip-phase", "Town phase: " + phase, "waiting", { choice: this.trip?.reverseChoice } );
} );
Activity.wrap( Town, "fail", function( result, reason ) { Activity.end( "town", "Town trip stopped: " + reason, "unconfirmed" ); } );
Activity.wrap( Town, "tick", function() {
	if ( !this.trip && Activity.contexts.town ) Activity.end( "town", this.message,
		/hunting resumed/.test( this.message ) ? "confirmed" : "cancelled" );
} );
Activity.wrap( Town, "checkScroll", function() {
	if ( this.trip?.scrollRequest?.accepted ) Activity.transition( "town", "scroll-accepted", "Travel request accepted; waiting for verified arrival.", "confirmed", { choice: this.trip.reverseChoice } );
} );
Activity.wrap( Town, "arrived", function() {
	if ( this.trip ) Activity.emit( { category: "town", code: "town-arrival", text: "Town arrival verified; beginning services.", outcome: "confirmed", operationId: Activity.contexts.town?.id } );
} );
Activity.wrap( Hunt, "chooseTarget", function( target ) {
	if ( target ) Activity.transition( "combat", "target-selected", "Selected target " + target.gid + " by " + this.cfg().priority + " priority.", "requested", {
		distance: dist2D( World.pose(), target ), monsterId: target.gid, selectionPolicy: this.cfg().priority,
		attackingPlayer: (World.simNow() ?? 0) - (World.attackers.get( target.gid ) ?? -Infinity) < 6000
	} );
} );
Activity.wrap( Chase, "abandon", function( result, target, reason ) {
	Activity.emit( { category: "movement", code: "approach-abandoned", level: "warn", text: "Target " + target.gid + ": " + reason, outcome: "unconfirmed", details: { monsterId: target.gid, revision: Navigation.revision, durationMs: now() - this.s.at } } );
} );
Activity.wrap( Stats, "potion", function( result, item ) {
	const ref = item.refObjId, previous = Activity.pendingPotions.get( ref ), me = World.me();
	if ( Activity.pendingPotions.size >= 16 && !previous ) return;
	Activity.pendingPotions.set( ref, { before: previous?.before ?? Stats.total( ref ), count: (previous?.count || 0) + 1,
		at: now(), epoch: World.epoch, details: { hpPct: me.hpPct, mpPct: me.mpPct, delayMs: Settings.profile.potion.delayMs } } );
} );
bus.on( "gameplay", () => Activity.observePotions() );
bus.on( "reset", () => { Activity.pendingPotions.clear(); Activity.states.clear(); } );
/*
================
Settings activity
================
*/
Activity.settingValues = () => ( {
	potion: !!Settings.profile.potion.enabled,
	town: !!Town.cfg().enabled,
	revival: !!Town.cfg().revive,
	detour: !!Hunt.cfg().detour.enabled,
	trap: !!Hunt.cfg().trap.enabled,
	support: !!Settings.profile.party.support.enabled
} );
Activity.savedSettings = Activity.settingValues();
Activity.wrap( Settings, "saveProfile", function() {
	const current = Activity.settingValues();
	for ( const key of Object.keys( current ) ) if ( current[key] !== Activity.savedSettings[key] ) {
		Activity.emit( { category: "settings", code: "toggle-" + key, text: key + " automation " + (current[key] ? "enabled." : "disabled.") } );
	}
	Activity.savedSettings = current;
} );
bus.on( "profile", () => { Activity.savedSettings = Activity.settingValues(); } );
Activity.wrap( Loot, "gained", function( result, item ) {
	if ( result ) Activity.emit( { category: "loot", code: "pickup-confirmed", text: "Inventory gain observed for pickup " + item.gid + ".", outcome: "confirmed" } );
} );
Activity.wrap( WalkBack, "tick", function() {
	Activity.transition( "movement", "walk-back-state", WalkBack.active ? "Walk-back active; waiting for observed arrival." : "Walk-back inactive." );
} );
bus.on( "cast", cast => {
	if ( cast.caster !== World.localGid() ) return;
	Activity.emit( { category: "combat", level: "cmd", code: "cast-observed", text: "Local skill action observed for skill " + cast.skill + ".", outcome: "confirmed" } );
} );
Activity.wrap( BuffGear, "tick", function() {
	if ( this.run && !Activity.contexts.buff ) Activity.begin( "buff", "Buff equipment cycle started." );
	else if ( !this.run && Activity.contexts.buff ) Activity.end( "buff", this.message, this.message === "Combat gear restored." ? "confirmed" : "unconfirmed" );
} );
Activity.wrap( Diagnostics, "sample", function() {
	Activity.observePotions();
	if ( !Town.trip && Activity.contexts.town ) Activity.end( "town", Town.message,
		/stopped/i.test( Town.message ) ? "unconfirmed" : "cancelled" );
	const messages = [ [ "reconnect", Reconnect.message, !!Reconnect.intent ],
		[ "buff", BuffGear.waiting || BuffGear.message, !!BuffGear.run || !!BuffGear.recovery || !!BuffGear.waiting ],
		[ "potion", PetPotion.message, !!PetPotion.cfg().on ],
		[ "movement", Chase.message, !!Chase.s ], [ "party", Party.message, Settings.profile.party.autoRecruit ] ];
	for ( const [ category, text, active ] of messages ) {
		if ( category === "potion" && /^Pet HP \d+%;/.test( text ) ) continue;
		if ( active && text ) Activity.transition( category, "state-change", text, /unconfirmed/i.test( text ) ? "unconfirmed" : "waiting" );
	}
	if ( Hunt.running && !Hunt.targetGid && now() - (Activity.searchAt ?? -Infinity) >= 10000 ) {
		Activity.searchAt = now();
		Activity.transition( "combat", "target-search", "Searching for target: " + Diagnostics.noTarget() );
	}
} );
