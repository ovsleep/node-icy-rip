import icecast = require('icy');
import fs = require('fs');
import path = require('path');
import output = require('./output');
import discover = require('./discover');
import progress = require('./progress');
import log = require('./log');
import homedir = require('homedir');

export interface Args {
    url: string;
    outputFolder: string;
    teeToStdout: boolean;
    appendDate: boolean;
    name: string
}

export interface TrackInfo {
    title: string;
}

export interface Filter {
    (track: TrackInfo): boolean;
}

export interface Settings {
    filter: Filter;
}

const SETTINGS_FILE = '.icy-rip';

function getSettingsFiles(): string[] {
    return [process.cwd(), homedir()].map(it => path.join(it, SETTINGS_FILE));
}

function loadFilters(): Filter[] {
    return getSettingsFiles().map(it => {
        try {
            const settings: Settings = require(it);
            return settings.filter;
        } catch (err) {
            if (err.code !== 'MODULE_NOT_FOUND') {
                log(`Error while loading settings file '${it}': ${err}.`);
            }
            return null;
        }
    }).filter(it => !!it);
}

function matches(track: TrackInfo, filters: Filter[]): boolean {
    for (let i = 0, n = filters.length; i < n; i++) {
        if (!filters[i](track)) {
            return false;
        }
    }
    return true;
}

function padLeft(num: number, paddingValue:string): string{
    return String(paddingValue + num).slice(-paddingValue.length);
}

function getDateStr(){
    var date = new Date();
    return `_${date.getFullYear()}${padLeft(date.getMonth()+1, '00')}${padLeft(date.getDate(),'00')}`
}

export function main(args?: Args) {
    args =  parseProcessArgs();
    console.log(args);
    if (!args) {
        log('Usage: icy-rip <url> [optional output folder][-t writes audio data to stdout]');
        return;
    }

    let terminate = false;
    let sigInts = 0;
    const doNothing = () => { /* do nothing */ };
    const writeToStdout: (data: any) => void = args.teeToStdout ? data => process.stdout.write(data) : doNothing;
    const progressTask: (msg: string) => void = args.teeToStdout ? doNothing : progress.task;
    const filters = loadFilters();
    if (args.teeToStdout) {
        process.stdout.on('error', doNothing);
    }

    log.enabled = !args.teeToStdout;

    fixMaxEventListenersWarning();

    process.on('SIGINT', () => {
        terminate = true;
        log('\nWriting last packet before terminating.\n');
        if (sigInts++ > 3) {
            process.exit();
        }
    });

    discover.discoverIcyUrl(args.url, (icyUrl, err) => {

        if (err) {
            log('Discover says: ' + err);
        }

        icecast.get(icyUrl, (res: any) => {

            log(`Recording from ${icyUrl} to ${args.outputFolder}`);
            log(`Headers:`);
            log(formatHeaders(res.headers));

            const genre = res.headers['icy-genre'] || '';
            const album = res.headers['icy-name'] || '';

            let outFile: output.File;
            let doOutput: boolean = true;

            res.on('metadata', function(metadata: any) { // do not =>
                const meta = icecast.parse(metadata);

                log(`META******`);
                log(meta);
                const newTitle = meta.StreamTitle;
                let trackNumberOffset = 0;
                if (outFile && outFile.streamTitle !== newTitle) {
                    if (outFile.isInitialFileWithoutMetadata) {
                        outFile.deleteOnClose = true;
                        trackNumberOffset = -1;
                    }
                    outFile.close();
                    outFile = undefined;
                }

                if (!outFile) {
                    doOutput = matches({ title: newTitle }, filters);
                    if (doOutput) {
                        outFile = new output.File(args.outputFolder, trackNumberOffset, album, genre, newTitle);
                    } else {
                        log(`\nSkipping ${newTitle}.`);
                    }
                }
            });

            res.on('data', (data: Buffer) => {

                if (doOutput) {
                    if (!outFile) {

                        let newTitle = args.name || '';
                        if(args.appendDate){
                            let date = new Date();
                            let dateStr = getDateStr()
                            newTitle = `${newTitle}_${dateStr}`
                        }
                        outFile = new output.File(args.outputFolder, 0, album, genre, newTitle);
                        outFile.isInitialFileWithoutMetadata = true;
                    }

                    progressTask(outFile.fileName);

                    outFile.write(data);
                    writeToStdout(data);
                }

                if (terminate) {
                    output.onFileCompleted = process.exit;
                    if (outFile) {
                        outFile.close();
                    } else {
                        output.onFileCompleted();
                    }
                }
            });
        });
    });
}

interface Parsed {
    args: string[];
    tee: boolean;
    appendDate: boolean;
}

function findTee(args: string[]): Parsed {
    const all: string[] = [];
    let tee = false;
    let date = false;
    args.forEach(it => {
        if (it === '-t') {
            tee = true;
        } else if (it == '-d'){
            date = true;
        }
        else {
            all.push(it);
        }
    });
    return { args: all, tee: tee, appendDate: date };
}

export function parseProcessArgs(): Args {
    const parsed = findTee(process.argv);
    const args = parsed.args;
    if (args.length < 3) {
        return undefined;
    }

    let folder = args[3];
    if (!folder) {
        folder = path.join(process.cwd(), 'recordings');
        if (!fs.existsSync(folder)) {
            fs.mkdirSync(folder);
        }
    }
    let name = args[4];

    return { url: args[2], outputFolder: folder, teeToStdout: parsed.tee, name: name, appendDate: parsed.appendDate };
}

function formatHeaders(headers: any): string {
    return Object.keys(headers).sort().map(k => `    ${k}: ${headers[k]}`).join('\n');
}

function fixMaxEventListenersWarning(): void {
    try {
        // http://stackoverflow.com/questions/9768444/possible-eventemitter-memory-leak-detected
        require('events').EventEmitter.prototype._maxListeners = 100;
    } catch (e) {
        log(e);
    }
}