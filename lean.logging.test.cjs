/*
===========================================================================
lean.logging.test.cjs - retention, privacy and observation contracts

Tests activity independently of gameplay decisions using the bot fixture.
===========================================================================
*/
module.exports = function loggingTests( { test, fixture, townFixture } ) {
	const assert = require( "node:assert/strict" );
	test( "routine refusals keep one count while retaining changing skill evidence", () => {
		const f = fixture();
		for ( let id = 500; id < 510; id++ ) {
			f.bus.emit( "command", { kind: "skill", skillId: id } );
			f.bus.emit( "game-error", "Cast rejected: 5" ); f.advance( 10 );
		}
		assert.equal( f.Activity.refusals.length, 1 );
		assert.equal( f.Activity.refusals[0].repeatCount, 10 );
		const exported = JSON.parse( f.Activity.export() ).events[0];
		assert.equal( exported.failureSamples.length, 8 );
		assert.equal( exported.failure.recentCommands.at( -1 ).skillId, 509 );
	} );
	test( "routine cast cooldown refusals use one informational row and retain export evidence", () => {
		const f = fixture();
		for ( let i = 0; i < 12; i++ ) {
			f.bus.emit( "game-error", "Cast rejected: 5" ); f.Log.info( "Other activity " + i ); f.advance( 1000 );
		}
		assert.equal( f.Log.lines.filter( entry => entry.level === "warn" ).length, 0 );
		assert.equal( f.Activity.refusals.length, 1 );
		assert.equal( f.Activity.refusals[0].repeatCount, 12 );
		assert.equal( f.Activity.visible().filter( entry => entry.code === "cast-not-ready" ).length, 1 );
		const entry = JSON.parse( f.Activity.export() ).events.find( entry => entry.code === "cast-not-ready" );
		assert.equal( entry.failure.source, "cast" );
		assert.equal( entry.failure.reason, "cooldown-or-action-recovery" );
		assert.match( entry.failure.explanation, /cooling down.*recovering/ );
		assert.equal( entry.details.errorCode, 5 );
		assert.equal( entry.failure.nativeErrorCode, 0x3005 );
		assert.match( f.Activity.export( false, "text" ), /cooldown-or-action-recovery/ );
		f.Activity.filters.category = "loot"; f.Activity.filters.level = "warn";
		assert.match( f.Activity.export(), /cooldown-or-action-recovery/ );
	} );
	test( "cast refusal exports show recent commands without claiming an exact request match", () => {
		const f = fixture();
		f.World.ents.set( 77, { gid: 77, kind: "monster", name: "Private name" } );
		f.bus.emit( "command", { kind: "skill", skillId: 500, gid: 77 } );
		f.advance( 100 ); f.bus.emit( "game-error", "Cast rejected: 5" );
		const entry = JSON.parse( f.Activity.export() ).events[0];
		assert.equal( entry.failure.recentCommands[0].skillId, 500 );
		assert.equal( entry.failure.recentCommands[0].monsterId, 77 );
		assert.equal( entry.failure.recentCommands[0].ageMs, 100 );
		assert.match( entry.failure.correlation, /not-a-request-match/ );
		assert.doesNotMatch( f.Activity.export(), /Private name/ );
		f.advance( 3100 ); f.bus.emit( "game-error", "Cast rejected: 5" );
		assert.equal( f.Activity.refusals.at( -1 ).failure.recentCommands.length, 0 );
	} );
	test( "inventory code 5 is never decoded as cast cooldown and zero error codes are preserved", () => {
		const f = fixture();
		f.bus.emit( "game-error", "Inventory rejected: 5" );
		const entry = f.Log.lines[0];
		assert.equal( entry.level, "warn" ); assert.equal( entry.failure.source, "inventory" );
		assert.equal( entry.failure.reason, "unmapped-error" );
		f.bus.emit( "game-error", "Cast rejected: 0" );
		assert.equal( f.Log.lines.at( -1 ).details.errorCode, 0 );
	} );
	test( "cast progress prevents readiness stall warnings and persistent stalls are rate limited", () => {
		const f = fixture(); f.Hunt.running = true;
		f.bus.emit( "game-error", "Cast rejected: 5" ); f.advance( 16000 );
		f.bus.emit( "cast", { caster: 1, skill: 500 } );
		f.bus.emit( "game-error", "Cast rejected: 5" );
		assert.equal( f.Log.lines.filter( entry => entry.code === "cast-readiness-stalled" ).length, 0 );
		f.advance( 16000 ); f.bus.emit( "game-error", "Cast rejected: 5" );
		assert.equal( f.Log.lines.filter( entry => entry.code === "cast-readiness-stalled" ).length, 1 );
		f.advance( 1000 ); f.bus.emit( "game-error", "Cast rejected: 5" );
		assert.equal( f.Log.lines.filter( entry => entry.code === "cast-readiness-stalled" ).length, 1 );
	} );
	test( "world resets prevent old commands from being attached to new refusals", () => {
		const f = fixture(); f.bus.emit( "command", { kind: "skill", skillId: 500 } );
		f.bus.emit( "reset" ); f.World.epoch++; f.bus.emit( "game-error", "Cast rejected: 5" );
		assert.equal( f.Activity.refusals[0].failure.recentCommands.length, 0 );
		f.Activity.clear(); assert.equal( JSON.parse( f.Activity.export() ).events.length, 0 );
	} );
	test( "friendly target messages retain technical selection evidence for export", () => {
		const f = fixture();
		const target = { gid: 466785, name: "Mangyang", kind: "monster", regionId: 1, x: 130, y: 0, z: 100, attackFlags: 16, appearanceState: [0] };
		f.World.ents.set( target.gid, target );
		f.World.attackers.set( target.gid, f.World.simNow() );
		f.Hunt.chooseTarget();
		const entry = f.Log.lines.find( entry => entry.code === "target-selected" );
		assert.ok( entry );
		assert.equal( f.Activity.userMessage( entry ), "Targeting Mangyang — it’s attacking you." );
		assert.doesNotMatch( f.Activity.userMessage( entry ), /466785|priority|requested/ );
		f.World.ents.delete( target.gid );
		assert.match( f.Activity.userMessage( entry ), /Mangyang/ );
		const exported = JSON.parse( f.Activity.export() ).events.find( event => event.code === "target-selected" );
		assert.equal( exported.details.monsterId, 466785 );
		assert.equal( exported.details.selectionPolicy, "attackers" );
		assert.equal( exported.details.attackingPlayer, true );
		assert.doesNotMatch( f.Activity.export(), /Mangyang/ );
		assert.match( f.Activity.export( true ), /Mangyang/ );
	} );
	test( "friendly logs distinguish targeting from a confirmed hit and handle unnamed monsters", () => {
		const f = fixture();
		for ( const policy of [ "nearest", "lowhp", "attackers" ] ) {
			f.Activity.clear(); f.Activity.states.clear(); f.Settings.profile.hunt.priority = policy;
			f.World.ents.set( 77, { gid: 77, kind: "monster", regionId: 1, x: 110, z: 100, attackFlags: 16, appearanceState: [0] } );
			f.Hunt.chooseTarget();
			const entry = f.Log.lines.find( event => event.code === "target-selected" );
			assert.equal( f.Activity.userMessage( entry ), "Targeting a monster." );
			assert.equal( entry.outcome, "requested" );
		}
	} );
	test( "friendly town and loot wording does not remove technical export fields", () => {
		const f = fixture();
		const entry = f.Activity.emit( { code: "trip-phase", category: "town", text: "Town phase: walk-smith", outcome: "waiting" } );
		assert.equal( f.Activity.userMessage( entry ), "Walking to the repair merchant." );
		assert.match( f.Activity.export( true ), /Town phase: walk-smith/ );
		assert.equal( f.Activity.userMessage( { code: "pickup-confirmed" } ), "Picked up loot." );
	} );
	test( "confirmed pickups name the item and its Star/Moon/Sun seal in the log", () => {
		const f = fixture();
		f.Items.data.set( 903, { name: "Sun sword", icon: "", code: "ITEM_CH_SWORD_01_C_RARE" } );
		f.Items.data.set( 902, { name: "Moon blade", icon: "", code: "ITEM_CH_BLADE_01_B_RARE" } );
		f.Items.data.set( 900, { name: "Plain sword", icon: "", code: "ITEM_CH_SWORD_01" } );
		const logged = a => {
			f.Activity.clear();
			f.Loot.count = () => 1;
			f.Loot.gained( Object.assign( { gid: 5, gold: false, petGid: 0, before: 0 }, a ) );
			return f.Activity.userMessage( f.Log.lines.find( entry => entry.code === "pickup-confirmed" ) );
		};
		assert.equal( logged( { ref: 903, name: "Sun sword" } ), "Picked up Sun sword (Seal of Sun)." );
		assert.equal( logged( { ref: 902 } ), "Picked up Moon blade (Seal of Moon)." );
		assert.equal( logged( { ref: 900, name: "Plain sword" } ), "Picked up Plain sword." );
	} );
	test( "command capture is opt-in and cannot evict normal warnings", () => {
		const f = fixture();
		f.Log.warn( "Important warning" );
		f.Log.cmd( "Move" );
		assert.equal( f.Activity.commands.length, 0 );
		f.Activity.capture( true );
		for ( let i = 0; i < 1200; i++ ) f.Log.command( { kind: "move" }, "Move " + i );
		assert.equal( f.Activity.commands.length, 1000 );
		assert.ok( f.Log.lines.some( entry => entry.text === "Important warning" ) );
		assert.ok( f.Activity.commands.every( entry => entry.outcome === "requested" ) );
		f.advance( 600001 ); f.Log.cmd( "Expired" );
		assert.equal( f.Activity.commands.at( -1 ).text, "Move 1199" );
	} );
	test( "duplicate grouping preserves operation and epoch boundaries", () => {
		const f = fixture();
		f.Log.warn( "Repeated" ); f.Log.warn( "Repeated" );
		assert.equal( f.Log.lines.length, 1 ); assert.equal( f.Log.lines[0].repeatCount, 2 );
		f.Activity.emit( { level: "warn", text: "Repeated", operationId: 1 } );
		f.Activity.emit( { level: "warn", text: "Repeated", operationId: 2 } );
		f.World.epoch++; f.Activity.emit( { level: "warn", text: "Repeated", operationId: 2 } );
		assert.equal( f.Log.lines.length, 4 );
	} );
	test( "standard export excludes free text and unapproved details", () => {
		const f = fixture();
		f.Activity.emit( { text: "SecretHero at 123,456 password private", code: "test-event", operationId: "SecretHero",
			details: { hpPct: 35, password: "private", player: "SecretHero", x: 123, delayMs: Infinity } } );
		const text = f.Activity.export();
		// Millisecond timestamps are digits too; leave them out so the check does not depend on the clock.
		assert.doesNotMatch( text.replace( /"(at|lastAt)": \d+/g, "" ).replace( /"version": "[\d.]+"/, "" ), /SecretHero|password|private|123|456/ );
		assert.equal( JSON.parse( text ).events[0].details.hpPct, 35 );
		assert.match( f.Activity.export( true ), /SecretHero/ );
		assert.doesNotMatch( f.Activity.export( false, "text" ), /SecretHero/ );
	} );
	test( "alchemy outcomes and game refusals enter shared activity once", () => {
		const f = fixture();
		f.Alchemy.note( "Success: +1 → +2" );
		f.bus.emit( "game-error", "Inventory rejected: 134" );
		assert.equal( f.Log.lines.filter( entry => entry.category === "alchemy" ).length, 1 );
		assert.equal( f.Log.lines.find( entry => entry.code === "alchemy-result" ).outcome, "confirmed" );
		assert.equal( f.Log.lines.find( entry => entry.code === "game-refusal" ).details.errorCode, 134 );
	} );
	test( "filters change views without deleting retained events", () => {
		const f = fixture();
		f.Activity.emit( { category: "town", level: "warn", text: "Town waiting" } );
		f.Activity.emit( { category: "combat", text: "Attack waiting" } );
		f.Activity.filters.category = "town";
		assert.equal( f.Activity.visible().length, 1 );
		f.Activity.filters.search = "absent";
		assert.equal( f.Activity.visible().length, 0 ); assert.equal( f.Log.lines.length, 2 );
		f.Activity.clear(); assert.equal( f.Log.lines.length, 0 );
		assert.equal( f.commands.length, 0 );
	} );
	test( "potion requests remain unconfirmed until inventory changes", () => {
		const f = fixture();
		const item = { slot: 13, refObjId: 8, typeFlags: 2284, quantity: 5 };
		f.World.gp.inventory = [ item ];
		f.Activity.capture( true ); f.Stats.potion( item ); f.Activity.observePotions();
		assert.equal( f.Activity.commands.filter( entry => entry.code === "potion-consumed" ).length, 0 );
		item.quantity = 4; f.Activity.observePotions();
		assert.equal( f.Activity.commands.filter( entry => entry.code === "potion-consumed" ).length, 1 );
		f.Activity.observePotions();
		assert.equal( f.Activity.commands.filter( entry => entry.code === "potion-consumed" ).length, 1 );
	} );
	test( "unconfirmed potion observations time out without claiming non-consumption", () => {
		const f = fixture(), item = { refObjId: 8, quantity: 5 };
		f.World.gp.inventory = [ item ]; f.Stats.potion( item );
		f.advance( 16000 ); f.Activity.observePotions();
		assert.equal( f.Log.lines.find( entry => entry.code === "potion-unconfirmed" ).outcome, "unconfirmed" );
		item.quantity--; f.Activity.observePotions();
		assert.equal( f.Activity.potionCount, 0 );
	} );
	test( "old potion observations cannot confirm across a world reset", () => {
		const f = fixture(), item = { refObjId: 8, quantity: 5 };
		f.World.gp.inventory = [ item ]; f.Stats.potion( item ); f.bus.emit( "reset" );
		item.quantity--; f.Activity.observePotions();
		assert.equal( f.Activity.potionCount, 0 );
	} );
	test( "same-character travel retains town correlation while character changes clear it", () => {
		const f = townFixture();
		f.bus.emit( "character", "One" ); f.Town.begin();
		const id = f.Activity.contexts.town.id;
		f.bus.emit( "character", "One" ); assert.equal( f.Activity.contexts.town.id, id );
		f.bus.emit( "character", "Two" ); assert.equal( f.Activity.contexts.town, undefined );
	} );
	test( "logging observation preserves owner return values and exceptions", () => {
		const f = fixture(), owner = { tick() { return 7; }, fail() { throw Error( "original failure" ); } };
		f.Activity.wrap( owner, "tick", () => { throw Error( "logging failure" ); } );
		f.Activity.wrap( owner, "fail", () => {} );
		assert.equal( owner.tick(), 7 ); assert.throws( () => owner.fail(), /original failure/ );
		assert.equal( f.commands.length, 0 );
	} );
};
