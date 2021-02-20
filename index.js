#!/usr/bin/env node

const fs = require('fs');
const util = require('util');
const https = require('https');
const pkg = require('./package.json');
const log = require('yalm');
const environmentVariablesPrefix = pkg.name.replace(/[^a-zA-Z\d]/, '_').toUpperCase();
const config = require('yargs')
    .env(environmentVariablesPrefix)
    .usage(pkg.name + ' ' + pkg.version + '\n' + pkg.description + '\n\nUsage: $0 [options]')
    .describe('verbosity', 'Possible values: "error", "warn", "info", "debug"')
    .describe('port', 'Local port for the http server providing the authorization callback.')
    .describe('client-id', 'Data of your Spotify App. Create an application here: https://developer.spotify.com/my-applications')
    .describe('client-secret', 'Data of your Spotify App. Create an application here: https://developer.spotify.com/my-applications')
    .describe('read-only', 'Enable read-only mode for testing.')
    .describe('schedule', 'Cron-like node-schedule expression when to run this script.')
    .describe('persistence-file', 'Path to persistence.json file.')
    .describe('settings-file', 'Path to settings.yaml file.')
    .describe('redirect-url', 'URL where this script can be reached if you run it on a remote server or behind a proxy.')
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
        'persistence-file': './persistence.json',
        'settings-file': './settings.yaml'
    })
    .demandOption([
        'client-id',
        'client-secret'
    ])
    .version()
    .help('help')
    .argv;
const SpotifyWebApi = require('spotify-web-api-node');
const SpotifyWebApiTools = require('./spotify-web-api-tools.js');
const express = require('express');
const schedule = require('node-schedule');
const onChange = require('on-change');
const Yatl = require('yetanothertimerlibrary');
const yaml = require('js-yaml');

// Parse arguments
log.setLevel(config.verbosity);
log.info(pkg.name + ' ' + pkg.version + ' starting');
log.debug('loaded config:', config);
log.debug('ENV Prefix:', environmentVariablesPrefix);

// Load persistence
let unwatchedPersistence = {
    tokens: {},
    playlists: {}
};

try {
    const json = fs.readFileSync(config.persistenceFile);
    unwatchedPersistence = Object.assign(unwatchedPersistence, JSON.parse(json));
} catch {
    // ...
}

log.debug('loaded persistence file:', unwatchedPersistence);

const persist = onChange(unwatchedPersistence, () => {
    const json = JSON.stringify(unwatchedPersistence, ...((config.verbosity === 'debug') ? [null, 2] : []));

    fs.writeFile(config.persistenceFile, json, error => {
        if (error) {
            log.error('Error saving Persistence', error.message);
        }
    });
});

// Load settings file
const settings = (() => {
    let yamlfile;
    try {
        yamlfile = yaml.safeLoad(fs.readFileSync(config.settingsFile, 'utf8'));
    } catch (error) {
        log.error('Unable to load Settings File', error);
        process.exit(1);
    }

    const tmp = {
        archiver: []
    };

    function nameByStringOrObject(option) {
        if (typeof option === 'string') {
            return option;
        }

        if (typeof option === 'object') {
            return option.name;
        }
    }

    for (const element of yamlfile.archiver) {
        if (typeof element === 'string') {
            tmp.archiver.push({
                source: {
                    name: element,
                    findByPersistence: false
                },
                target: {
                    name: element + ' (save)',
                    findByPersistence: true
                }
            });
        }

        if (typeof element === 'object') {
            tmp.archiver.push({
                source: {
                    name: nameByStringOrObject(element.source),
                    id: element.source.id,
                    findByPersistence: element.source.findByPersistence ?? false
                },
                target: {
                    name: nameByStringOrObject(element.target),
                    id: element.target.id,
                    findByPersistence: element.source.findByPersistence ?? true
                }
            });
        }
    }

    return tmp;
})();
log.debug('loaded settings', util.inspect(settings, {depth: null, colors: true}));

// Prepare Spotify Api
const scopes = ['playlist-read-private', 'playlist-read-collaborative', 'playlist-modify-public', 'playlist-modify-private'];
const redirectUri = config.redirectUrl || `http://localhost:${config.port}/callback`;

const spotify = new SpotifyWebApi({
    redirectUri,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    accessToken: persist.tokens.accessToken,
    refreshToken: persist.tokens.refreshToken
});
const swat = new SpotifyWebApiTools(spotify);

async function refreshToken() {
    const data = await spotify.refreshAccessToken();

    const accessToken = data.body.access_token;
    const expiresIn = data.body.expires_in;

    log.debug('Access Token has been refreshed:', accessToken);

    spotify.setAccessToken(accessToken);
    persist.tokens.accessToken = accessToken;

    const refreshInterval = expiresIn / 2 * 1000;
    if (refreshInterval !== refreshTimer.interval) {
        log.debug('Setting Refresh Interval', refreshInterval);
        refreshTimer.restart(refreshInterval);
    }
}

const refreshTimer = new Yatl.Timer(refreshToken);

// Check Auth Status on Start
(async () => {
    if (persist.tokens.refreshToken) {
        await refreshToken();
        if (await checkAuth()) {
            mainScheduler.invoke();
        } else {
            log.error('Cloud not refresh token');
        }
    } else {
        log.info('Please authenticate via web browser.');
    }
})();

// Provide HTTP Callback Server for Auth
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
    log.info(`${pkg.name} listening on port ${config.port}. Open with your browser: http://THIS_IP:${config.port}/login`);
});

// Scheduler
const mainScheduler = schedule.scheduleJob(config.schedule, async () => {
    if (!await checkAuth()) {
        log.error('Not authorized!');
        return;
    }

    // const userId = (await spotify.getMe()).body.id;
    const userPlaylists = await swat.getAllUserPlaylists();

    for (const element of settings.archiver) {
        try {
            const sourceId =
                element.source.id ||
                (element.source.findByPersistence && findPlaylistIdByNameInPersist(element.source.name)) ||
                (await swat.findUserPlaylistByName(element.source.name, userPlaylists))?.id;

            if (!sourceId) {
                log.warn(`Source playlist '${element.source.name}' could not be found.`);
                continue;
            }

            const targetId =
                element.target.id ||
                (element.target.findByPersistence && findPlaylistIdByNameInPersist(element.target.name)) ||
                (await swat.findUserPlaylistByName(element.target.name, userPlaylists))?.id ||
                (await spotify.createPlaylist(element.target.name, {public: false})).body.id;

            // Copy over Cover Image
            try {
                const sourcePlaylist = (await spotify.getPlaylist(sourceId)).body;
                const imageBase64 = await getImageFromUrlAsBase64(sourcePlaylist.images[0].url);
                await spotify.uploadCustomPlaylistCoverImage(targetId, imageBase64);
            } catch (error) {
                log.warn('Error copying Cover Image ' + error);
            }

            const sourceName = element.source.name ||
                userPlaylists.find(p => p.id === sourceId)?.name;
            const targetName = element.target.name ||
                userPlaylists.find(p => p.id === targetId)?.name;

            if (!persist.playlists[targetId]) {
                persist.playlists[targetId] = {
                    tracks: [],
                    blacklist: []
                };
            }

            if (!persist.playlists[sourceId]) {
                persist.playlists[sourceId] = {
                    tracks: [],
                    blacklist: []
                };
            }

            persist.playlists[sourceId].name = sourceName;
            persist.playlists[targetId].name = targetName;

            log.debug(`archiving from ${sourceName} (${sourceId}) to ${targetName} (${targetId})`);

            await playlistArchiveContents(sourceId, targetId);
        } catch (error) {
            log.error(error);
        }
    }

    log.info('Job finished');
});
log.debug('scheduler', mainScheduler);

// Functions
async function checkAuth() {
    try {
        await spotify.getMe();
        return true;
    } catch {
        return false;
    }
}

function diff(a, b) {
    return a.filter(element => !b.includes(element));
}

function mergeUnique(a, b) {
    return [...new Set([...a, ...b])];
}

function findPlaylistIdByNameInPersist(name) {
    const filtered = objectFilter(persist.playlists, (id, playlist) => playlist.name === name);
    const count = Object.keys(filtered).length;

    if (count === 1) {
        return Object.entries(filtered)[0][0];
    }

    if (count === 0) {
        return;
    }

    if (count > 1) {
        throw new Error('Playlist Name not unique ' + name);
    }
}

async function addTracks(id, list) {
    const chunkLength = 100;

    if (Array.isArray(list) && list.length > 0) {
        for (let i = 0; i < list.length; i += chunkLength) {
            const chunk = list.slice(i, i + chunkLength);
            try {
                await spotify.addTracksToPlaylist(id, chunk);
            } catch (error) {
                throw new Error('Error in addTracks', id, 'chunk', i, error);
            }
        }
    }
}

function getImageFromUrlAsBase64(url) {
    return new Promise((resolve, reject) => {
        https.get(url, {
            headers: {
                Authorization: 'Bearer ' + spotify.getAccessToken()
            }
        }, response => {
            const contentType = response.headers['content-type'];
            if (contentType !== 'image/jpeg') {
                throw new Error('Wrong content-type: ' + contentType);
            }

            const data = [];
            response.on('data', chunk => {
                data.push(chunk);
            });
            response.on('end', () => {
                resolve(Buffer.concat(data).toString('base64'));
            });
        }).on('error', error => {
            reject(error);
        });
    });
}

async function getTracks(id) {
    const raw = await swat.getAllPlaylistTracks(id);
    const tracks = raw.filter(t => t.track?.uri);
    return tracks.map(t => t.track.uri);
}

async function playlistArchiveContents(sourceId, targetId) {
    if (!persist.playlists[targetId]) {
        persist.playlists[targetId] = {
            tracks: [],
            blacklist: []
        };
    }

    const tracksTarget = await getTracks(targetId);

    // Get diff between locally saved state and "Playlist (save)", save to deleted playlist and get it
    const deletedByMe = diff(persist.playlists[targetId].tracks, tracksTarget);
    persist.playlists[targetId].blacklist = mergeUnique(persist.playlists[targetId].blacklist, deletedByMe);

    // Gett source playlist tracks
    const tracksSource = await getTracks(sourceId);

    // Get new tracks, filter deleted/blacklisted tracks
    const newTracks = diff(tracksSource, tracksTarget);
    const newTracksWithoutDeleted = diff(newTracks, persist.playlists[targetId].blacklist);

    // Add new tracks to my playlist
    await addTracks(targetId, newTracksWithoutDeleted);

    // Save my playlist for next run
    persist.playlists[targetId].tracks = await getTracks(targetId);
}

function objectFilter(obj, predicate) {
    return Object.fromEntries(Object.entries(obj).filter(([key, obj]) => predicate(key, obj)));
}
