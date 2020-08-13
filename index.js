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
const schedule = require('node-schedule');

log.setLevel(config.verbosity);
log.info(pkg.name + ' ' + pkg.version + ' starting');
log.debug('loaded config: ', config);

const scopes = ['playlist-read-private', 'playlist-read-collaborative', 'playlist-modify-public', 'playlist-modify-private'];
const redirectUri = `http://localhost:${config.port}/callback`;

const spotify = new SpotifyWebApi({
    redirectUri,
    clientId: config.clientId,
    clientSecret: config.clientSecret
});

checkAuth().then(result => log.debug('Check auth:', result));

const app = express();

app.get('/login', (request, response) => {
    log.debug(request.params, request.body);
    response.redirect(spotify.createAuthorizeURL(scopes));
});

app.get('/callback', (request, response) => {
    if (request.query.error) {
        log.error('Callback Error:', error);
        response.send(`Callback Error: ${error}`);
        return;
    }

    const code = request.query.code;
    const state = request.query.state;
    log.debug('Callback', code, state);

    spotify.authorizationCodeGrant(code).then(data => {
        const accessToken = data.body.access_token;
        const refreshToken = data.body.refresh_token;
        const expiresIn = data.body.expires_in;

        spotify.setAccessToken(accessToken);
        spotify.setRefreshToken(refreshToken);

        log.debug('access_token:', accessToken);
        log.debug('refresh_token:', refreshToken);

        log.info(`Sucessfully retreived access token. Expires in ${expiresIn} s.`);
        response.send('Success! You can now close the window.');

        setInterval(async () => {
            const data = await spotify.refreshAccessToken();
            const access_token = data.body['access_token'];

            console.log('The access token has been refreshed!');
            console.log('access_token:', access_token);
            spotify.setAccessToken(access_token);
        }, expiresIn / 2 * 1000);

        checkAuth().then(result => {
            log.debug('Check auth:', result);

            if (result) {
                mainScheduler.invoke();
            }
        });
    }).catch(error => {
        log.error('Error getting Tokens:', error);
        response.send(`Error getting Tokens: ${error}`);
    });
});

app.listen(config.port, () => {
    log.info(`${config.name} listening on port ${config.port}`);
});

let savedState = [];
const mainScheduler = schedule.scheduleJob('0 0 4 * * *', async () => {
    try {
        if (await checkAuth()) {
            const myPlaylists = await spotify.getAllUserPlaylists();
            const filteredPlaylists = myPlaylists.filter(p => /^Test/.test(p.name));
            log.debug('Using playlists', filteredPlaylists.map(p => p.name));

            const originalPlaylist = filteredPlaylists.find(p => /^Test$/.test(p.name));
            const myPlaylist = filteredPlaylists.find(p => /\(save\)$/.test(p.name));
            const blacklistPlaylist = filteredPlaylists.find(p => /\(deleted\)$/.test(p.name));

            const tracksMine = (await spotify.getAllPlaylistTracks(myPlaylist.id)).map(t => t.track.uri);
            log.debug('Your playlist', tracksMine);

            // Get diff between locally saved state and "Playlist (save)", save to deleted playlist and get it
            const deletedByMe = savedState.filter(x => !tracksMine.includes(x));
            if (Array.isArray(deletedByMe) && deletedByMe.length) {
                log.debug('You deleted', deletedByMe);
                await spotify.addTracksToPlaylist(blacklistPlaylist.id, deletedByMe);
            }
            const tracksBlacklist = (await spotify.getAllPlaylistTracks(blacklistPlaylist.id)).map(t => t.track.uri);
            log.debug('New Blacklist', tracksBlacklist);

            // Gett source playlist tracks
            const tracksOriginal = (await spotify.getAllPlaylistTracks(originalPlaylist.id)).map(t => t.track.uri);
            log.debug('Source Playlist', tracksOriginal);

            // Get new tracks, filter deleted/blacklisted tracks
            const newTracks = tracksOriginal.filter(x => !tracksMine.includes(x));
            log.debug('New tracks in source playlist', newTracks);
            const newTracksWithoutDeleted = newTracks.filter(x => !tracksBlacklist.includes(x));

            // Add new tracks to my playlist
            if (Array.isArray(newTracksWithoutDeleted) && newTracksWithoutDeleted.length) {
                log.debug('Adding new songs', newTracksWithoutDeleted);
                await spotify.addTracksToPlaylist(myPlaylist.id, newTracksWithoutDeleted);
            }

            // Save my playlist for next run
            savedState = (await spotify.getAllPlaylistTracks(myPlaylist.id)).map(t => t.track.uri);
            log.debug('New saved state', savedState);

        } else {
            log.warn('Not authorized!');
        }
    } catch(error) {
        log.error(error);
    }
});
log.debug('scheduler', mainScheduler);

async function checkAuth() {
    try {
        await spotify.getMe();
        return true;
    } catch {
        return false;
    }
}
