#!/usr/bin/env node

import chalk = require('chalk');
import fs = require('fs');
import querystring = require('querystring');
import readline = require('readline');
import crypto = require('crypto');
import toml = require('toml');
import http = require('http');
import url = require('url');
import chokidar = require('chokidar');



const setting_filename = "mimesync-settings.txt"
const hash_filename = "mimesync-hash.json"

const ignore_paths = ["node_modules", ".git", setting_filename, hash_filename]

const settings_initial = `#Settings file for ZMimeSync - Automatic Mime Sync for easier development

#SICF Service for ZMimeSync you can find more info at the documentation
#Example: "http://erpdev.company:8000/sap/bc/zmimesync_s001?sap-client=100"
mimesync_service = "" 

#Username on SAP system.
username = ""

#Password on SAP system. This is optional since you may not want to store it in plaintext.
#If there is no password field the tool asks you for password each time you run it.
password = ""

#Root Mime Path for BSP, etc. This is found at the bottom in BSP properties screen.
#Example: "/sap/bc/bsp/sap/zbsp_mimesync_ex/"
#Please note that you can also sync current folder to an subfolder in MIMEs.
#Example: "/sap/bc/bsp/sap/zbsp_mimesync_ex/my_folder/"
mime_url  = ""

#Request Number for SAP development.
#Example = "ERPK900141"
request_number = ""

`
interface IABAPExObject {
    [key: string]: string;
}
//abap return codes:
var abap_exceptions: IABAPExObject = {
    '1': 'parameter_missing',
    '2': 'error_occured',
    '3': 'cancelled',
    '4': 'permission_failure',
    '5': 'data_inconsistency',
    '6': 'new_loio_already_exists',
    '7': 'is_folder',
    '8': 'OTHERS'
}

interface IHashesObject {
    [key: string]: string;
}



async function main() {



    var settingExists = fs.existsSync(setting_filename);
    if (!settingExists) {
        fs.writeFileSync(setting_filename, settings_initial);
        console.log(chalk.bgYellow("ATTENTION!"));
        console.log(chalk.yellow("Initial settings file created, please edit: " + setting_filename));
        return;
    }

    var settingToml = fs.readFileSync(setting_filename, "utf-8");
    var settingData = toml.parse(settingToml);
    //console.dir(settingData);
    if (!settingData["mimesync_service"]) {
        console.log(chalk.yellow("mimesync_service") + " can not be empty please edit: " + setting_filename);
        return;
    }
    if (!settingData["username"]) {
        console.log(chalk.yellow("username") + " can not be empty please edit: " + setting_filename);
        return;
    }
    if (!settingData["mime_url"]) {
        console.log(chalk.yellow("mime_url") + " can not be empty please edit: " + setting_filename);
        return;
    }
    if (!settingData["request_number"]) {
        console.log(chalk.yellow("request_number") + " can not be empty please edit: " + setting_filename);
        return;
    }



    var file_path_list = walkFiles(".", function (file_path) {
        //file_path ./node_modules
        if (ignore_paths.indexOf(file_path.substring(2)) != -1) {
            return false
        }

        return true;
    });
    console.log(file_path_list)

    //if password doesn't exists in settings:
    if (!settingData["password"]) {
        const rl_pass = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });
        var password = await password_question(rl_pass, settingData['username']);
        settingData['password'] = password;
    }

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    var YN = await many_files_question_promise(rl, file_path_list);

    if (YN != 'Y') {
        return

    }
    
    await sync_files(file_path_list, settingData);
    var hashes = {};
    if (fs.existsSync(hash_filename)) {
        var hashes_str = fs.readFileSync(hash_filename, 'utf-8');
        hashes = JSON.parse(hashes_str);
    }

    console.log(chalk.bgGreen.black("Now watching the files!"))

    var watcher = chokidar.watch('.', { persistent: true });

    function watcher_triggered(filename: string) {
        if (filename.startsWith('node_modules')) {
            return
        }
        if (filename.startsWith('.git')) {
            return
        }
        var file_path = url.parse(filename).path;
        if (ignore_paths.indexOf(file_path) != -1) {
            return;
        }
        sync_files([url.parse(filename).path], settingData);
    }

    watcher.on('change', watcher_triggered)
        .on('add', watcher_triggered);
    //todo?: unlink delete file from mime
}

function password_question(rl_pass: readline.ReadLine, username: string): Promise<string> {
    return new Promise<string>((resolve) => {
        rl_pass.question('Please enter password for username ' + chalk.green(username) + ' and press enter:', (answer) => {
            resolve(answer);
        });
    });
}

function many_files_question_promise(rl: readline.ReadLine, file_path_list: string[]) {
    return new Promise<string>((resolve) => {
        many_files_question(rl, file_path_list, resolve);
    });
}

//this function tries to prevent accidentally syncing /* or C:\* :)
function many_files_question(rl: readline.ReadLine, file_path_list: string[], fn: any) {
    rl.question('There are' + chalk.yellow(' ' + file_path_list.length) + ' files. Do you want to sync this folder?(Y/N)', (answer) => {
        if (answer == 'Y' || answer == 'y') {
            rl.close();
            fn('Y')
        } else if (answer == 'N' || answer == 'n') {
            console.log(chalk.yellow('Sync task is aborted.'));
            rl.close();
            fn('N')
        } else {
            many_files_question(rl, file_path_list, fn);
        }
    });

}

//sync given file_path_list with controls and message logging
//if hash from memory is given use this, else try to read from file.
async function sync_files(file_path_list: string[], settingData: any, hashes?: IHashesObject) {
    if (!hashes) {
        hashes = {};
        if (fs.existsSync(hash_filename)) {
            var hashes_str = fs.readFileSync(hash_filename, 'utf-8');
            hashes = JSON.parse(hashes_str);
        }
    }

    for (var i = 0; i < file_path_list.length; i++) {
        var result = await sendFile(hashes, settingData['username'], settingData['password'], settingData['mimesync_service'], settingData['mime_url'], file_path_list[i], settingData['request_number'])
        if (result.trim() == '0') {
            console.log(chalk.green(file_path_list[i]) + ' synced successfully.');
        } else if (result == '-1') {
            console.log(chalk.cyan(file_path_list[i]) + ' file not changed after latest mime-sync.');
        } else if (result == '-2') {
            console.log(chalk.yellow(file_path_list[i]) + ' file is empty, skipped.');

        } else if (abap_exceptions.hasOwnProperty(result.trim())) {
            console.log(chalk.red(file_path_list[i]) + ' problem with syncing:')
            console.log(chalk.red('ABAP exception in service(mime_repository_api): ' + abap_exceptions[result.trim()]))
        } else {
            console.log(chalk.red(file_path_list[i]) + ' problem with syncing:')
            console.log(chalk.red(result))
        }
    }

    //write hash file
    var hashes_json = JSON.stringify(hashes);
    fs.writeFileSync(hash_filename, hashes_json, { encoding: 'utf-8' });


}


function walkFiles(dir: string, fileDecideFunc: (filename: string) => boolean) {
    var results = new Array<string>();
    var list = fs.readdirSync(dir);
    list.forEach(function (file) {
        file = dir + '/' + file;
        if (!fileDecideFunc(file)) {
            return; //means continue skipping this file/dir
        }
        var stat = fs.statSync(file);
        if (stat && stat.isDirectory()) {
            results = results.concat(walkFiles(file, fileDecideFunc));
        } else {
            results.push(file);
        }
    });
    return results
}





async function getHashForFile(file_path: string): Promise<string> {
    const hash = crypto.createHash("sha256");
    return new Promise<string>(resolve => {
        var input = fs.createReadStream(file_path);
        input.pipe(hash, { end: false });
        input.on('end', () => {
            resolve(hash.digest('base64'));
        });
    });
}

//gets hash and compares with old hash 
//if hash is different tries to send file.
//if sending is successful update the hash. otherwise log(return) warning.
async function sendFile(hashes: IHashesObject, username: string, password: string, mimesync_service: string, mime_root_url: string, file_path: string, request_number: string): Promise<string> {
    //normalize
    if (file_path.startsWith('./')) {
        file_path = file_path.substring(2);
    }

    var hash_val = await getHashForFile(file_path);
    if (hashes.hasOwnProperty(file_path)) {
        if (hashes[file_path] == hash_val) {
            return "-1" //"Already latest version."
        }
    }
    var mime_url = '';
    if (mime_root_url.endsWith('/')) {
        mime_url = mime_root_url + file_path;
    } else {
        mime_url = mime_root_url + '/' + file_path;
    }

    var file_bytes = fs.readFileSync(file_path);
    if (file_bytes.byteLength == 0) {
        return "-2" //"File is empty, skipping sync.";
    }
    var mime_content_base64 = file_bytes.toString('base64');

    var result = await sendFileHTTP(username, password, mimesync_service, mime_url, mime_content_base64, request_number);
    if (result.trim() == '0') {
        hashes[file_path] = hash_val;
    }
    //console.log(result);
    return result;
}


// https://nodejs.org/api/http.html
async function sendFileHTTP(username: string, password: string, mimesync_service: string, mime_url: string, mime_content_base64: string, request_number: string): Promise<string> {

    var content_base64 = ""
    var postData = querystring.stringify({
        'mime_url': mime_url,
        'mime_content': mime_content_base64,
        'request_number': request_number
    });

    var url_parts = url.parse(mimesync_service);
    //console.log(url_parts);

    var options = {
        hostname: url_parts.hostname,
        port: Number(url_parts.port),
        path: url_parts.path,
        protocol: url_parts.protocol,
        method: 'POST',
        headers: {
            'Authorization': 'Basic ' + new Buffer(username + ':' + password).toString('base64'),
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(postData)

        }
    };
    return new Promise<string>(function (resolve) {
        var result_str = '';
        var req = http.request(options, (res) => {
            if (res.statusCode == 401) {
                resolve(res.statusCode + ' ' + res.statusMessage)
            }

            //console.log(`STATUS: ${res.statusCode}`);
            //console.log(`HEADERS: ${JSON.stringify(res.headers)}`);
            res.setEncoding('utf8');
            res.on('data', (chunk) => {
                //console.log(`BODY: ${chunk}`);
                result_str = result_str + chunk;
            });
            res.on('end', () => {
                resolve(result_str);
                //console.log('No more data in response.');
            });
        });

        req.on('error', (e) => {
            resolve(e.message);
            //console.log(`problem with request: ${e.message}`);
        });

        // write data to request body
        req.write(postData);
        req.end();

    });

}



main();



