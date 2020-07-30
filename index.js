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
const {default: PQueue} = require('p-queue');
const queue = new PQueue({concurrency: 1});

log.setLevel(config.verbosity);
log.info(pkg.name + ' ' + pkg.version + ' starting');
log.debug('loaded config: ', config);

const scopes = ['playlist-read-private', 'playlist-read-collaborative', 'playlist-modify-public', 'playlist-modify-private'];
const redirectUri = `http://localhost:${config.port}/callback`;

const spotifyApi = new SpotifyWebApi({
    redirectUri,
    clientId: config.clientId,
    clientSecret: config.clientSecret
});

checkAuth().then(result => log.debug('Check auth:', result));

const app = express();

app.get('/login', (request, response) => {
    log.debug(request.params, request.body);
    response.redirect(spotifyApi.createAuthorizeURL(scopes));
});

app.get('/callback', (request, response) => {
    const error = request.query.error;
    const code = request.query.code;
    const state = request.query.state;
    log.debug('Callback', code, state);

    if (error) {
        log.error('Callback Error:', error);
        response.send(`Callback Error: ${error}`);
        return;
    }

    spotifyApi.authorizationCodeGrant(code).then(
        data => {
            const accessToken = data.body.access_token;
            const refreshToken = data.body.refresh_token;
            const expiresIn = data.body.expires_in;

            spotifyApi.setAccessToken(accessToken);
            spotifyApi.setRefreshToken(refreshToken);

            log.debug('access_token:', accessToken);
            log.debug('refresh_token:', refreshToken);

            log.info(`Sucessfully retreived access token. Expires in ${expiresIn} s.`);
            response.send('Success! You can now close the window.');

            checkAuth().then(result => log.debug('Check auth:', result));
        },
        error => {
            log.error('Error getting Tokens:', error);
            response.send(`Error getting Tokens: ${error}`);
        }
    );
});

app.listen(config.port, () => {
    log.info(`${config.name} listening on port ${config.port}`);
});

async function checkAuth() {
    try {
        await spotifyApi.getMe();
        return true;
    } catch {
        return false;
    }
}
