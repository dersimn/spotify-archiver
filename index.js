#!/usr/bin/env node

const pkg = require('./package.json');
const log = require('yalm');
const config = require('yargs')
    .env(pkg.name.replace(/[^a-zA-Z\d]/, '_').toUpperCase())
    .usage(pkg.name + ' ' + pkg.version + '\n' + pkg.description + '\n\nUsage: $0 [options]')
    .describe('verbosity', 'possible values: "error", "warn", "info", "debug"')
    .describe('port', 'local port for the http server providing the authorization callback')
    .alias({
        h: 'help',
        p: 'port',
        v: 'verbosity'
    })
    .default({
        port: 8888
    })
    .demandOption([
    ])
    .version()
    .help('help')
    .argv;
const SpotifyWebApi = require('spotify-web-api-node');
const express = require('express');

log.setLevel(config.verbosity);
log.info(pkg.name + ' ' + pkg.version + ' starting');
log.debug('loaded config: ', config);
