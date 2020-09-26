#!/usr/bin/env node

const fs = require('fs');
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
    .describe('schedule', 'Cron-like node-schedule expression when to run this script.')
    .describe('persistence-file', 'Path to persistence.json file.')
    .alias({
        h: 'help',
        p: 'port',
        i: 'client-id',
        s: 'client-secret',
        v: 'verbosity'
    })
    .default({
        port: 8888,
        'read-only': false,
        schedule: '0 0 4 * * *',
        'persistence-file': './persistence.json'
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
const onChange = require('on-change');
const Yatl = require('yetanothertimerlibrary');

// Parse arguments
log.setLevel(config.verbosity);
log.info(pkg.name + ' ' + pkg.version + ' starting');
log.debug('loaded config:', config);

// Load persistence
let unwatchedPersistence;
try {
    const json = fs.readFileSync(config.persistenceFile);
    unwatchedPersistence = JSON.parse(json);
} catch {
    unwatchedPersistence = {
        tokens: {},
        playlistContent: {}
    };
}

log.debug('loaded persistence file:', unwatchedPersistence);

const persist = onChange(unwatchedPersistence, () => {
    log.debug('Persistence changed');

    const json = JSON.stringify(unwatchedPersistence, ...((config.verbosity === 'debug') ? [null, 2] : []));

    fs.writeFile(config.persistenceFile, json, error => {
        if (error) {
            log.error('Error saving Persistence', error.message);
            return;
        }

        log.debug('Persistence saved');
    });
});

const scopes = ['playlist-read-private', 'playlist-read-collaborative', 'playlist-modify-public', 'playlist-modify-private'];
const redirectUri = `http://localhost:${config.port}/callback`;

const spotify = new SpotifyWebApi({
    redirectUri,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    accessToken: persist.tokens.accessToken,
    refreshToken: persist.tokens.refreshToken
});

const refreshTimer = new Yatl.Timer(async () => {
    const data = await spotify.refreshAccessToken();

    const accessToken = data.body.access_token;
    const expiresIn = data.body.expires_in;

    log.debug('Access Token has been refreshed:', accessToken);

    spotify.setAccessToken(accessToken);
    persist.tokens.accessToken = accessToken;

    if (expiresIn !== refreshTimer.interval) {
        const refreshInterval = expiresIn / 2 * 1000;

        log.debug('Setting Refresh Interval', refreshInterval);
        refreshTimer.restart(refreshInterval);
    }
});

checkAuth().then(result => {
    log.debug('Check auth:', result);

    if (result) {
        refreshTimer.exec();
        mainScheduler.invoke();
    }
});

const app = express();

app.get('/login', (request, response) => {
    log.debug(request.params, request.body);
    response.redirect(spotify.createAuthorizeURL(scopes));
});

app.get('/callback', (request, response) => {
    const error = request.query.error;
    if (error) {
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

        log.debug('access_token:', accessToken);
        log.debug('refresh_token:', refreshToken);

        spotify.setAccessToken(accessToken);
        spotify.setRefreshToken(refreshToken);
        persist.tokens.accessToken = accessToken;
        persist.tokens.refreshToken = refreshToken;

        log.info(`Sucessfully retreived access token. Expires in ${expiresIn} s.`);
        response.send('Success! You can now close the window.');

        refreshTimer.restart(expiresIn / 2 * 1000);

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

persist.playlistContent.Test = [];
const mainScheduler = schedule.scheduleJob(config.schedule, async () => {
    try {
        if (await checkAuth()) {
            const myPlaylists = await spotify.getAllUserPlaylists();
            const filteredPlaylists = myPlaylists.filter(p => p.name.startsWith('Test'));
            log.debug('Using playlists', filteredPlaylists.map(p => p.name));

            const originalPlaylist = filteredPlaylists.find(p => p.name === 'Test');
            const myPlaylist = filteredPlaylists.find(p => /\(save\)$/.test(p.name));
            const blacklistPlaylist = filteredPlaylists.find(p => /\(deleted\)$/.test(p.name));

            const tracksMine = await getTracks(myPlaylist.id);
            log.debug('Your playlist', tracksMine);

            // Get diff between locally saved state and "Playlist (save)", save to deleted playlist and get it
            const deletedByMe = diff(persist.playlistContent.Test, tracksMine);
            await addTracks(blacklistPlaylist.id, deletedByMe);
            const tracksBlacklist = await getTracks(blacklistPlaylist.id);
            log.debug('New Blacklist', tracksBlacklist);

            // Gett source playlist tracks
            const tracksOriginal = await getTracks(originalPlaylist.id);
            log.debug('Source Playlist', tracksOriginal);

            // Get new tracks, filter deleted/blacklisted tracks
            const newTracks = diff(tracksOriginal, tracksMine);
            log.debug('New tracks in source playlist', newTracks);
            const newTracksWithoutDeleted = diff(newTracks, tracksBlacklist);

            // Add new tracks to my playlist
            await addTracks(myPlaylist.id, newTracksWithoutDeleted);

            // Save my playlist for next run
            persist.playlistContent.Test = await getTracks(myPlaylist.id);
            log.debug('New saved state', persist.playlistContent.Test);
        } else {
            log.warn('Not authorized!');
        }
    } catch (error) {
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

function diff(a, b) {
    return a.filter(x => !b.includes(x));
}

async function addTracks(id, list) {
    if (Array.isArray(list) && list.length > 0) {
        return spotify.addTracksToPlaylist(id, list);
    }
}

async function getTracks(id) {
    return (await spotify.getAllPlaylistTracks(id)).map(t => t.track.uri);
}
