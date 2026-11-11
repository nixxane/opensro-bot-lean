/*
===========================================================================

lean-session.js - session window and shared activity history

Both log views read Log's bounded buffer. Opening a view never resets a
session or takes ownership of gameplay.
===========================================================================
*/
const SESSION_FIELDS = [
	[ "state", "Session" ], [ "time", "Hunting time" ], [ "xp", "XP gained" ],
	[ "rate", "XP / hour" ], [ "gold", "Net gold" ], [ "kills", "Confirmed kills" ],
	[ "deaths", "Deaths" ], [ "potions", "Potions used" ], [ "items", "Items picked up" ], [ "sox", "SoX found" ],
	[ "sun", "Seal of Sun" ], [ "moon", "Seal of Moon" ], [ "star", "Seal of Star" ]
];
const SESSION_LIMIT = { delayMs: 60000, bottomTolerance: 4 };

/*
================
UI.activityLog
================
*/
UI.activityLog = function( label ) {
	const log = el( "ol", null, "activity-history" );
	log.setAttribute( "aria-label", label );
	log.tabIndex = 0;
	return log;
};

/*
================
UI.renderActivity

Keep the first visible entry anchored while the reader browses older lines.
Only readers at the bottom follow new entries.
================
*/
UI.renderActivity = function( log ) {
	if ( !log || !log.isConnected || log.hidden ) return;
	log.refreshControls?.();
	if ( log.paused ) { if (log.activityStatus) log.activityStatus.textContent = 'Paused; new activity continues in history.'; return; }
	if ( this.selectedActivityText?.( log ) ) {
		if ( log.activityStatus ) log.activityStatus.textContent = 'Text selected; new activity continues in history.';
		return;
	}
	const viewKey = Activity.revision + ':' + JSON.stringify(Activity.filters);
	if ( log.viewKey === viewKey && log.rendered ) return;
	log.viewKey = viewKey;
	const follow = !log.rendered || log.scrollTop + log.clientHeight >= log.scrollHeight - SESSION_LIMIT.bottomTolerance;
	const top = log.scrollTop;
	const anchor = Array.from( log.children ).find( row => row.offsetTop + row.offsetHeight >= top );
	const offset = anchor ? anchor.offsetTop - top : 0;
	const rows = Activity.visible().map( entry => {
		const row = el( "li", null, entry.level );
		row.entry = entry;
		row.append( el( "time", new Date( entry.at ).toLocaleTimeString( "en-GB" ) ),
			el( "span", (entry.level === "warn" ? "Warning: " : entry.level === "error" ? "Error: " : "") + Activity.userMessage( entry ), "activity-message" ) );
		if ( entry.repeatCount > 1 ) {
			const repeat = el( "span", "×" + entry.repeatCount, "activity-repeat" );
			repeat.setAttribute( "aria-label", "Reported " + entry.repeatCount + " times" ); row.append( repeat );
		}
		return row;
	} );
	log.replaceChildren( ...rows );
	if (log.activityStatus) log.activityStatus.textContent = rows.length + ' events shown';
	log.rendered = true;
	const retained = anchor && rows.find( row => row.entry === anchor.entry );
	log.scrollTop = follow ? log.scrollHeight : retained ? retained.offsetTop - offset : top;
};

/*
================
UI.showSession
================
*/
UI.showSession = function( expandLogs = false ) {
	if ( !this.root ) return;
	if ( !this.sessionBox ) {
		this.sessionFields = {};
		const stats = el( "div", null, "session-values" );
		for ( const [ key, label ] of SESSION_FIELDS ) {
			const value = el( "span" );
			this.sessionFields[key] = value;
			stats.append( this.field( label, value ) );
			value.setAttribute( "aria-label", "Current session: " + label );
		}
		this.sessionLog = this.activityLog( "Session activity" );
		this.sessionLog.id = "session-activity";
		this.sessionLog.hidden = true;
		this.sessionLogPanel = this.activityPanel(this.sessionLog, "Session");
		this.sessionLogPanel.hidden = true;
		this.sessionArrow = this.button( "▼ Show logs", () => {
			this.sessionLog.hidden = !this.sessionLog.hidden;
			this.sessionLogPanel.hidden = this.sessionLog.hidden;
			this.sessionArrow.textContent = this.sessionLog.hidden ? "▼ Show logs" : "▲ Hide logs";
			this.sessionArrow.setAttribute( "aria-expanded", String( !this.sessionLog.hidden ) );
			this.renderActivity( this.sessionLog );
			this.fitWindow( this.sessionBox );
		} );
		this.sessionArrow.setAttribute( "aria-controls", this.sessionLog.id );
		this.sessionArrow.setAttribute( "aria-expanded", "false" );
		this.sessionBox = this.windowFrame( "Current session", () => { this.sessionBox.hidden = true; },
			stats, this.button( "Reset session totals", () => Stats.reset() ),
			el( "p", "Totals pause while stopped or disconnected. Net gold includes town expenses. Closing this window keeps hunting active.", "muted" ),
			this.sessionArrow, this.sessionLogPanel );
		this.sessionBox.classList.add( "session-window" );
		this.root.append( this.sessionBox );
		this.sessionBox.style.left = Math.max( 4, innerWidth - 450 ) + "px";
		this.sessionBox.style.top = "40px";
	}
	this.sessionBox.hidden = false;
	if ( expandLogs && this.sessionLog.hidden ) this.sessionArrow.click();
	this.updateSession();
	this.fitWindow( this.sessionBox );
	this.front( this.sessionBox );
};

/*
================
UI.updateSession
================
*/
UI.updateSession = function() {
	if ( Activity.captureUntil && now() >= Activity.captureUntil ) {
		Activity.capture( false );
	}
	if ( this.current === "Settings" ) this.renderActivity( this.logs );
	if ( this.logList ) this.renderActivity( this.logList );
	if ( !this.sessionBox || this.sessionBox.hidden ) return;
	const values = Stats.display();
	for ( const [ key, value ] of Object.entries( values ) ) {
		if ( this.sessionFields[key] ) this.sessionFields[key].textContent = value;
	}
	this.renderActivity( this.sessionLog );
};

/*
================
UI.potionDelay

Reject invalid text instead of silently replacing the player's last setting.
================
*/
UI.potionDelay = function() {
	const input = el( "input" );
	input.type = "number";
	input.min = 0;
	input.max = SESSION_LIMIT.delayMs;
	input.step = 1;
	input.value = Settings.profile.potion.delayMs;
	input.addEventListener( "change", () => {
		const value = input.value.trim() === "" ? NaN : Number( input.value );
		if ( !Number.isInteger( value ) || value < 0 || value > SESSION_LIMIT.delayMs ) {
			input.value = Settings.profile.potion.delayMs;
			this.toast( "Potion delay must be a whole number from 0 to 60000 ms.", "warn" );
			return;
		}
		Activity.emit({category:'settings', code:'potion-delay-changed', text:'Potion delay changed from ' + Settings.profile.potion.delayMs + ' to ' + value + ' ms.', details:{delayMs:value}});
		Settings.profile.potion.delayMs = value;
		Settings.saveProfile();
	} );
	return this.field( "Potion delay (ms)", input );
};

/*
================
Session event bindings
================
*/
bus.on( "hunt", () => UI.updateSession() );
bus.on( "character", () => UI.updateSession() );
