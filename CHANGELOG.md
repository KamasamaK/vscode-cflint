# Change Log

All notable changes to the VS Code CFLint extension will be documented in this file.

## [0.3.1] - 2018-12-17

- Improved rule retrieval to only fetch online at most once per hour
- Missing or invalid path settings now prompt with an open dialog instead of asking for the path to be written out
- Replaced some `require` with ES6 imports
- Updated launch configuration
- Added separate `compile` script
- Added check to prevent linting on open event when entire workspace is being scanned by CFML extension
- Updated TypeScript to 3.2.2

## [0.3.0] - 2018-10-22

- Added code actions for ignoring rules in `.cflintrc`, transforming variable case, and var/local scoping
- Updated `.cflintrc` schema
- Now only explicitly uses `-configfile` when altConfigFile.path is valid
- Added CFLint version check and notifies if below minimum or latest version
- Added `DiagnosticTag.Unnecessary` to diagnostics for `UNUSED_LOCAL_VARIABLE`
- Removed issue ID/code from message
- Updated TypeScript to 3.1.3
- Updated Tasks to 2.0.0

## [0.2.4] - 2017-11-27

- Added commands to output results to a file.
- Added new tsconfig options

## [0.2.3] - 2017-11-03

- Updated engine and dependencies
- Fixed a configuration setting
- Changed tsconfig options
- Updated tslint rule
- Added "Open File" option when creating a config file that already exists
- Replaced some `Thenable`s with async/await

## [0.2.2] - 2017-10-02

- Added `cflint.maxSimultaneousLints` setting along with the feature it controls, which queues any lints that exceed that number.

## [0.2.1] - 2017-10-01

- Removed extension dependency
- Made some commands asynchronous
- Added type casting to configuration retrieval
- Changed configuration update to use `ConfigurationTarget`
- Added extension recommendations for extension developers and updated dependencies

## [0.2.0] - 2017-08-15

- Added status bar indicator
- Prevent overlapping linting for a file
- Added better error messaging
- Added new commands for clearing problems
- Replaced deprecated variable due to introduction of multi-root workspaces
- Updated dependencies

## [0.1.2] - 2017-08-02

- Removed unnecessary dependency
- Improved README

## [0.1.1] - 2017-07-31

- Added new error message when opening config file that does not exist
- Improved README

## [0.1.0] - 2017-07-29

- Initial release
