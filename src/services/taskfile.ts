import * as cp from 'child_process';
import * as vscode from 'vscode';
import * as models from '../models';
import * as path from 'path';
import * as fs from 'fs';
import * as semver from 'semver';
import { settings } from '../settings';
import { Octokit } from 'octokit';
import { Endpoints } from "@octokit/types";

const octokit = new Octokit();
type ReleaseRequest = Endpoints["GET /repos/{owner}/{repo}/releases/latest"]["parameters"];
type ReleaseResponse = Endpoints["GET /repos/{owner}/{repo}/releases/latest"]["response"];

const minimumRequiredVersion = '3.19.1';
const minimumRecommendedVersion = '3.23.0';

class TaskfileService {
    private static _instance: TaskfileService;
    private static outputChannel: vscode.OutputChannel;
    private lastTaskName: string | undefined;
    private lastTaskDir: string | undefined;

    private constructor() {
        TaskfileService.outputChannel = vscode.window.createOutputChannel('Task');
    }

    public static get instance() {
        return this._instance ?? (this._instance = new this());
    }

    private command(command?: string): string {
        if (command === undefined) {
            return settings.path;
        }
        return `${settings.path} ${command}`;
    }

    public async checkInstallation(): Promise<string> {
        return await new Promise((resolve) => {
            let command = this.command('--version');
            cp.exec(command, (_, stdout: string, stderr: string) => {

                // If the version is a devel version, ignore all version checks
                if (stdout.includes("devel")) {
                    return resolve("ready");
                }

                // Get the installed version of task (if any)
                let version = this.parseVersion(stdout);

                // If there is an error fetching the version, assume task is not installed
                if (stderr !== "" || version === undefined) {
                    vscode.window.showErrorMessage("Task command not found.", "Install").then(this.buttonCallback);
                    return resolve("notInstalled");
                }

                // If the current version is older than the minimum required version, show an error
                if (version && version.compare(minimumRequiredVersion) < 0) {
                    vscode.window.showErrorMessage(`Task v${minimumRequiredVersion} is required to run this extension. Your current version is v${version}.`, "Update").then(this.buttonCallback);
                    return resolve("outOfDate");
                }

                // If the current version is older than the minimum recommended version, show a warning
                if (version && version.compare(minimumRecommendedVersion) < 0) {
                    vscode.window.showWarningMessage(`Task v${minimumRecommendedVersion} is recommended to run this extension. Your current version is v${version} which doesn't support some features.`, "Update").then(this.buttonCallback);
                    return resolve("ready");
                }

                // If a newer version is available, show a message
                // TODO: what happens if the user is offline?
                if (settings.checkForUpdates) {
                    this.getLatestVersion().then((latestVersion) => {
                        if (version && latestVersion && version.compare(latestVersion) < 0) {
                            vscode.window.showInformationMessage(`A new version of Task is available. Current version: v${version}, Latest version: v${latestVersion}`, "Update").then(this.buttonCallback);
                        }
                        return resolve("ready");
                    }).catch((err) => {
                        console.error(err);
                        return resolve("notInstalled");
                    });
                }
            });
        });
    }

    buttonCallback(value: string | undefined) {
        if (value === undefined) {
            return;
        }
        if (["Update", "Install"].includes(value)) {
            vscode.env.openExternal(vscode.Uri.parse("https://taskfile.dev/installation"));
            return;
        }
    }

    async getLatestVersion(): Promise<semver.SemVer | null> {
        let request: ReleaseRequest = {
            owner: 'go-task',
            repo: 'task'
        };
        let response: ReleaseResponse = await octokit.rest.repos.getLatestRelease(request);
        return Promise.resolve(semver.parse(response.data.tag_name));
    }

    parseVersion(stdout: string): semver.SemVer | undefined {
        // Extract the version string from the output
        let matches = stdout.match(/v(\d+\.\d+\.\d+)/);
        if (!matches || matches.length !== 2) {
            return undefined;
        }
        // Parse the version string as a semver
        let version = semver.parse(matches[1]);
        if (!version) {
            return undefined;
        }
        return version;
    }

    public async init(dir: string): Promise<void> {
        return await new Promise((resolve) => {
            let command = this.command('--init');
            cp.exec(command, { cwd: dir }, (_, stdout: string, stderr: string) => {
                if (stderr) {
                    vscode.window.showErrorMessage(stderr);
                }
                this.open(dir).then(() => {
                    return resolve();
                });
            });
        });
    }

    public async open(dir: string): Promise<void> {
        let filenames = ['Taskfile.yml', 'Taskfile.yaml', 'taskfile.yml', 'taskfile.yaml'];
        for (let i = 0; i < filenames.length; i++) {
            let filename = path.join(dir, filenames[i]);
            if (fs.existsSync(filename)) {
                await vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(filename), { preview: false });
                return;
            }
        }
    }

    public async read(dir: string): Promise<models.Taskfile> {
        return await new Promise((resolve) => {
            let command = this.command('--list-all --json');
            cp.exec(command, { cwd: dir }, (_, stdout: string) => {
                var taskfile: models.Taskfile = JSON.parse(stdout);
                taskfile.workspace = dir;
                return resolve(taskfile);
            });
        });
    }

    public async runLastTask(): Promise<void> {
        if (this.lastTaskName === undefined) {
            vscode.window.showErrorMessage(`No task has been run yet.`);
            return;
        }
        await this.runTask(this.lastTaskName, this.lastTaskDir);
    }

    public async runTask(taskName: string, dir?: string): Promise<void> {
        return await new Promise((resolve) => {
            // Spawn a child process
            let child = cp.spawn(this.command(), [taskName], { cwd: dir });

            // Clear the output channel and show it
            TaskfileService.outputChannel.clear();
            TaskfileService.outputChannel.show();

            // Listen for stderr
            child.stderr.setEncoding('utf8');
            child.stderr.on("data", data => {
                TaskfileService.outputChannel.append(data.toString());
            });

            // Listen for stdout
            child.stdout.setEncoding('utf8');
            child.stdout.on("data", data => {
                TaskfileService.outputChannel.append(data.toString());
            });

            // When the task finishes, print the exit code and resolve the promise
            child.on('close', code => {
                TaskfileService.outputChannel.append(`task: completed with code ${code}\n`);
                this.lastTaskName = taskName;
                this.lastTaskDir = dir;
                return resolve();
            });
        });
    }

    public async goToDefinition(task: models.Task, preview: boolean = false): Promise<void> {
        if (task.location === undefined) {
            vscode.window.showErrorMessage(`Go to definition requires Task v3.23.0 or higher.`, "Update").then(this.buttonCallback);
            return;
        }

        let position = new vscode.Position(task.location.line - 1, task.location.column - 1);
        let range = new vscode.Range(position, position);

        // Create the vscode URI from the Taskfile path
        let file = vscode.Uri.file(task.location.taskfile);

        // Create the vscode text document show options
        let options: vscode.TextDocumentShowOptions = {
            selection: range,
            preview: preview
        };

        // Run the vscode open command with the range options
        try {
            await vscode.commands.executeCommand('vscode.open', file, options);
        } catch (err) {
            console.error(err);
        }
    }
}

export const taskfile = TaskfileService.instance;
