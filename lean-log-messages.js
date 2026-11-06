/*
===========================================================================
lean-log-messages.js - player-facing activity descriptions

Keep technical messages, codes and evidence unchanged for diagnostic exports.
Capture monster names when events occur so despawns cannot rewrite history.
===========================================================================
*/

/*
================
Activity.userMessage
================
*/
Activity.userMessage = function( entry ) {
	if ( entry.userText ) return entry.userText;
	const messages = {
		"character-boundary": "Character loaded.",
		"session-start": "Hunting session started.",
		"session-summary": "Hunting paused. Session totals are saved until you reset or reload.",
		"town-arrival": "Arrived in town; starting town services.",
		"scroll-accepted": "Return travel has started; waiting to arrive.",
		"inventory-confirmed": "Town supplies or inventory updated.",
		"pickup-confirmed": "Picked up loot.",
		"potion-consumed": "Potion used.",
		"pet-kit-consumed": "Pet recovery kit used.",
		"potion-unconfirmed": "Couldn’t confirm potion use yet. The game may still be processing it.",
		"game-refusal": "The game couldn’t complete the request. See the diagnostic export for details."
	};
	// Capture history must describe its original event, not today's filter state.
	if ( entry.code === "capture-changed" ) return /enabled/.test( entry.text ) ? "Detailed logging enabled for 10 minutes." : "Detailed logging stopped.";
	if ( messages[entry.code] ) return messages[entry.code];
	if ( entry.code === "walk-leg" ) return "Walking to the hunting spot: leg " + entry.details.leg + " of about " + entry.details.legs + ".";
	if ( entry.code === "potion-summary" ) return "Potions used since the last update: " + entry.details.quantity + ".";
	if ( entry.code === "trip-phase" ) {
		const phase = entry.text.replace( /^Town phase: /, "" );
		const phases = {
			recall: "Preparing to return to town.", "recall-wait": "Returning to town…",
			"revive-arrival": "Waiting to revive in town.", "walk-arrival": "Walking to the town start.", "walk-storage": "Walking to the warehouse.",
			"service-wait": "Waiting for the town to load, then trying again.", "open-storage": "Opening the warehouse.", store: "Depositing loot.", "close-storage": "Finished at the warehouse.",
			"walk-vendor": "Walking to the potion merchant.", "open-vendor": "Opening the potion shop.",
			buy: "Buying supplies.", "close-vendor": "Finished buying supplies.",
			"walk-smith": "Walking to the repair merchant.", "open-smith": "Opening the repair shop.",
			sell: "Selling loot.", ammo: "Buying ammunition.", repair: "Repairing equipment.",
			"close-smith": "Finished at the repair merchant.", "walk-gate": "Walking to the return point.",
			"open-gate": "Opening return travel.", reverse: "Preparing to return to the hunting area.",
			"reverse-wait": "Returning to the hunting area…",
			leave: "Finished town services; walking back to the hunting spot."
		};
		return phases[phase] || "Continuing town services.";
	}
	if ( entry.level === "cmd" ) {
		if ( entry.code === "command-move" ) return "Requesting movement.";
		if ( entry.code === "cast-observed" ) return "Skill use confirmed by the game.";
		return "Requested: " + entry.text;
	}
	if ( entry.code === "target-search" ) return "Looking for a suitable monster.";
	if ( entry.text === "Walk-back active; waiting for observed arrival." ) return "Walking back to the hunting spot.";
	if ( entry.text === "Walk-back inactive." ) return "Walk-back ended.";
	if ( /^Dropped blocked target:/.test( entry.text ) ) return "Couldn’t reach the monster; looking for another target.";
	if ( /^Letting the game approach/.test( entry.text ) ) return "Moving closer to the monster.";
	return entry.text;
};

/*
================
UI.selectedActivityText

Only handle selections contained in one log. Other page selections keep their
normal browser behavior, including copy from inputs and export previews.
================
*/
UI.selectedActivityText = function( expectedLog = null ) {
	const selection = this.root?.getSelection?.() || W.getSelection?.();
	if ( !selection || !selection.rangeCount || selection.isCollapsed ) return "";
	const range = selection.getRangeAt( 0 );
	const node = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
	const log = node?.closest?.( ".activity-history" );
	if ( !log || expectedLog && log !== expectedLog || log.getRootNode() !== this.root || !log.contains( range.endContainer ) ) return "";
	return selection.toString();
};
