/**
 * udu Logging
 * Version: 0.1.0
 * Author: Bruce Clounie <bruce.clounie@udu.nu>
 */
var util = require('util');

var _ = require('lodash');
var argv = require('minimist')(process.argv.slice(2));
var clc = require('cli-color');
var logsene = require('winston-logsene');
var winston = require('winston');

/**
 * Notes
 * 1. The three variables below ONLY affect logs in the console. 
 		They DO NOT affect the logs sent to Logsene.
 * 2. Flag help - all of the following are true: --flag, --flag=true, --flag true
 */

/**
 * Lowest level of logs displayed in console. See RFC5424 comment below for list of levels
 * Default: info
 * Flag Ex: --logLevel debug
 */
var LOG_LEVEL = ( _.isString( argv.logLevel ) ? argv.logLevel : null ) || process.env.LOG_LEVEL || 'debug';
if ( argv.testLogging ) {
	LOG_LEVEL = 'debug';
}

/**
 * Displays metadata in console. 
 * Default: false. 
 * Flag Ex: --meta
 */
var DISPLAY_META = argv.meta === true || process.env.DISPLAY_META === 'true' || false;

/**
 * Displays timestamp in console.
 * Default: false
 * Flag Ex: --timestamp
 */
var DISPLAY_TIMESTAMP = argv.timestamp === true || process.env.DISPLAY_TIMESTAMP === 'true' || false;

/**
 * Export log exports to all transports
 * Default: false
 * Flag Ex: --exportLogs
 */
var EXPORT_LOGS = argv.exportLogs === true || process.env.EXPORT_LOGS === 'true' || false;

/**
 * Enables log exports to Logsene
 * Default: false
 * Flag Ex: --exportLogsToLogsene, 
 */
var EXPORT_TO_LOGSENE = argv.exportLogsToLogsene || process.env.EXPORT_LOGS_TO_LOGSENE === 'true' || false;
if ( EXPORT_LOGS ) {
	EXPORT_TO_LOGSENE = true;
}
/**
 * Logging levels from RFC5424 (Syslog Protocol):
 *  0: emerg	- One or more systems are unusable. (Ex: No response from www.udu.io)
 *  1: alert 	- A person must take an action immediately. (Ex: Set of Kubernetes pods (say, public-facing) unavailable)
 *  2: crit 	- Critical events cause more severe problems or brief outages. (Ex: MongoDB is at 100% CPU, or a pod is restarting constantly)
 *  3: error 	- Error events are likely to cause problems.
 *  4: warning - Warning events might cause problems.
 *  5: notice 	- Normal but significant events, such as start up, shut down, or configuration.
 *  6: info 	- Routine information, such as ongoing status or performance.
 *  7: debug 	- Debug or trace information.
 */
var customLevelsConfig = { 
	emerg: function ( txt ) { return clc.xterm(220).bold.bgXterm(160)('EMERGENCY'); },
	alert: function ( txt ) { return clc.xterm(161).bold.bgXterm(170)('ALERT'); },
	crit: function ( txt ) { return clc.xterm(124).bold.bgXterm(208)('CRITICAL'); },
	error: function ( txt ) { return clc.red('ERROR'); },
	warning: clc.xterm(208),
	notice: clc.yellow,
	info: clc.blue,
	debug: clc.white
};

var logger = new winston.Logger({
	transports: [
		new (winston.transports.Console)({ 
			level: LOG_LEVEL,
			timestamp: function() {
			  return '[' + (new Date()).toISOString() + ']';
			},
	      formatter: function(options) {
	      	var formattedMsg = '';
	      	if ( DISPLAY_TIMESTAMP ) {
	      		formattedMsg += ( options.timestamp() + ' ' );
	      	}
	      	formattedMsg += _.capitalize(customLevelsConfig[options.level](_.capitalize(options.level))) + ': ' + 
	      		(undefined !== options.message ? options.message : '');
	      	if ( DISPLAY_META ) {
	          	formattedMsg += (options.meta && Object.keys(options.meta).length ? '\n\tMeta: '+ JSON.stringify(options.meta) : '' );
	      	}
	      	return formattedMsg;
	      }
		}),
	]
});

/**
 * Notes
 * In general, most application-related problems will use the 'error' level, or below.
 * NEVER: USE 'emergency' or 'alert' levels in application code. For infrastructure-related issues only.
 * RARELY: use 'critical' in application code. See description.
 */
logger.setLevels(winston.config.syslog.levels);
logger.emergency = logger.emerg;
logger.critical = logger.crit;

// Add Logsene as a transport (without this, it's just console logs)
if ( EXPORT_TO_LOGSENE ) {
	logger.notice( '[uduLogger] Now exporting logs to Logsene' );
	logger.add(logsene, {token: process.env.LOGSENE_TOKEN, type: 'test_logs', level: LOG_LEVEL });
}

// List of meta keys allowed
var allowedCalleeMeta = [
	'codeRepository', // Ex: uduinc/core, uduinc/n-apps
	'n-app', // Ex: 'edu.umd.terrorism.js'
	'organization',
	'request', // Ex: 'udu-query-55fjf93'
	'user', 
	'source' // REQUIRED. Ex: 'lib/udu-multipod.js'
];
var globalMetaData = {
	// We do not want udu-logging to be dependent on configs...because it's used in the configs.
	hostname: process.env.THIS_POD_NAME || require('os').hostname(),
};

var uduLogger = {};
_.forOwn( customLevelsConfig, function ( fn, level ) {
	uduLogger[level] = function ( scopedMeta ) 
	{
		var args = _.values( arguments );
		var msg;
		var validMeta;

		// If they passed a meta object..
		if ( args.length && _.isObject(args[args.length - 1]) && args[args.length - 1].__isUduMeta__ ) {

			// Extract the non-meta arguments
			var theArgs = _.slice( args, 1, args.length - 1 );
			_.each( theArgs, function ( arg, idx ) { if ( _.isObject( arg ) ) { theArgs[idx] = util.inspect( arg, { colors: true, depth: 4 }) } } );
			msg = theArgs.join( ' ' );

			// Put the message's meta in the right place as well
			meta = args[args.length - 1] || {};

			// Enforce schema so nobody can screw up Elasticsearch
			var validMeta = _.pick(
				_.merge( _.cloneDeep(meta), scopedMeta ),
				allowedCalleeMeta
			);
			if ( meta.source === 'n-app' ) {
				validMeta.source = 'n-app';
			}

			// Make it easy to find logging vandalization
			if ( !_.isString( msg ) ) {
				logger.warning( 'BAD LOG, CANNOT FIND SOURCE. \n\tLog: ' + msg, _.merge( validMeta, globalMetaData ) );
				return;
			}
		}

		// If they didn't pass a meta object..
		if ( !validMeta ) {
			// msg = _.slice( args, 1, args.length ).join( ' ' );
			var theArgs = _.slice( args, 1, args.length );
			
			_.each( theArgs, function ( arg, newIdx ) { if ( _.isObject( arg ) ) { theArgs[newIdx] = util.inspect( arg, { colors: true, depth: 4 }) } } );
			msg = theArgs.join( ' ' );
			// msg = args.join( ' ' );			
			validMeta = scopedMeta;
		}
		if ( validMeta.source === 'unknown_callee' ) {
			logger.warning( 'BAD LOG, CANNOT FIND SOURCE. \n\tLog: ' + msg, _.merge( validMeta, globalMetaData ) );
			return;
		}
		// Example meta object: { 'n-app': 'edu.umd.terrorism', user: 'bruce', organization: 'udu-admin' }
		logger[level]( msg, _.merge( validMeta, globalMetaData ) ); 
		// throw 'yoyo';
	};
});

module.exports = (function( source, sourceMeta ) {
	// This way we never create more than one instance of uduLogger
	// Instead, we create multiple wrappers, all of which call the uduLogger object
	source = _.isString( source ) ? source : 'unknown_callee';
	sourceMeta = _.isObject( sourceMeta ) ? sourceMeta : {};

	function uduLoggerInstance( ) {
		var self = this;
		var meta = _.merge( sourceMeta, { source: source } );
		if ( !meta.codeRepository ) {
			meta.codeRepository = process.env.THIS_CODE_REPOSITORY || 'uduinc/core';
		}
		_.forOwn( customLevelsConfig, function ( fn, level ) {
			self[level] = _.bind(uduLogger[level], uduLogger[level], meta );
		});
	}
	var inst = new uduLoggerInstance();
	_.each( _.keys(inst), function ( key ) {
		console[key] = inst[key];
	});
	console['log'] = inst['debug'];
	console['warn'] = inst['warning'];
	return inst;
});

if ( argv.testLogging ) {
	logger.emerg( 'emerg' );
	logger.alert( 'alert' ); 
	logger.crit( 'crit' ); 
	logger.error( 'error' ); 
	logger.warning( 'warning' );
	logger.notice( 'notice' ); 
	logger.info( 'info' ); 

	// Same thing
	logger.debug( 'debug' );
	logger.log('log');
}

// Example
//
// var uduLogger = require('./udu-logging')(
// 	'terrorist_db/edu.umd.terrorism.js', 	{ 
// 		codeRepository: 'uduinc/n-apps', 
// 		'n-app': 'edu.umd.terrorism.js' 
// 	}
// );
// uduLogger.warning('yoyo test warn', { user: 'bruce', request: 'udu-query-1337kewl' } );