#!/usr/bin/env node

const pkg = require('./package.json');
const log = require('yalm');
const config = require('yargs')
    .env(pkg.name.replace(/[^a-zA-Z\d]/, '_').toUpperCase())
    .usage(pkg.name + ' ' + pkg.version + '\n' + pkg.description + '\n\nUsage: $0 [options]')
    .describe('verbosity', 'Possible values: "error", "warn", "info", "debug"')
    .describe('port', 'Local port for the http server providing the authorization callback.')
    .describe('client-id', 'Data of your Spotify App. Create an application here: https://developer.spotify.com/my-applications')
    .describe('client-secret', 'Data of your Spotify App. Create an application here: https://developer.spotify.com/my-applications')
    .describe('read-only', 'Enable read-only mode for testing.')
    .alias({
        h: 'help',
        p: 'port',
        i: 'client-id',
        s: 'client-secret',
        v: 'verbosity'
    })
    .default({
        port: 8888,
        'read-only': false
    })
    .demandOption([
        'client-id',
        'client-secret'
    ])
    .version()
    .help('help')
    .argv;
const SpotifyWebApi = require('spotify-web-api-node');
const express = require('express');

log.setLevel(config.verbosity);
log.info(pkg.name + ' ' + pkg.version + ' starting');
log.debug('loaded config: ', config);

const scopes = ['playlist-read-private', 'playlist-read-collaborative', 'playlist-modify-public', 'playlist-modify-private'];
const redirectUri = `http://localhost:${config.port}/callback`;

const spotifyApi = new SpotifyWebApi({
    redirectUri: redirectUri,
    clientId: config.clientId,
    clientSecret: config.clientSecret
});

const app = express();

app.get('/login', (req, res) => {
    log.debug(req.params, req.body);
    res.redirect(spotifyApi.createAuthorizeURL(scopes));
});

app.get('/callback', (req, res) => {
    const error = req.query.error;
    const code = req.query.code;
    const state = req.query.state;
    log.debug('Callback', code, state);

    if (error) {
        log.error('Callback Error:', error);
        res.send(`Callback Error: ${error}`);
        return;
    }

    spotifyApi.authorizationCodeGrant(code).then(
        data => {
            const access_token = data.body['access_token'];
            const refresh_token = data.body['refresh_token'];
            const expires_in = data.body['expires_in'];

            spotifyApi.setAccessToken(access_token);
            spotifyApi.setRefreshToken(refresh_token);

            log.debug('access_token:', access_token);
            log.debug('refresh_token:', refresh_token);

            log.info(`Sucessfully retreived access token. Expires in ${data.body['expires_in']} s.`);
            res.send('Success! You can now close the window.');
        },
        error => {
            log.error('Error getting Tokens:', error);
            res.send(`Error getting Tokens: ${error}`);
        }
    );
});

app.listen(config.port, () => {
    log.info(`${config.name} listening on port ${config.port}`);
});