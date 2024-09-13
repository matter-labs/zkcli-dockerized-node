import chalk from "chalk";
import ora from "ora";
import path from "path";
import { ModuleNode, files, git, docker, Logger } from "zksync-cli/lib";

import type { ConfigHandler } from "zksync-cli/lib";

type ModuleConfig = {
  version?: string;
};

let latestVersion: string | undefined;

const REPO_NAME = "matter-labs/local-setup";

export default class SetupModule extends ModuleNode<ModuleConfig> {
  constructor(config: ConfigHandler) {
    super(
      {
        name: "Dockerized node",
        description: "Persistent state, includes L1 and L2 nodes",
      },
      config
    );
  }

  gitUrl = `https://github.com/${REPO_NAME}.git`;
  get gitFolder() {
    return path.join(this.dataDirPath, "./local-setup");
  }
  get composeFile() {
    return path.join(this.gitFolder, "docker-compose.yml");
  }

  get nodeInfo() {
    return {
      id: 270,
      name: "Dockerized local node",
      network: "dockerized-node",
      rpcUrl: "http://127.0.0.1:3050",
      l1Chain: {
        id: 9,
        name: "L1 Local",
        network: "l1-local",
        rpcUrl: "http://127.0.0.1:8545",
      },
    };
  }

  get version() {
    return this.moduleConfig.version ?? undefined;
  }

  async getLatestVersion(): Promise<string> {
    if (!latestVersion) {
      latestVersion = await git.getLatestCommitHash(REPO_NAME);
    }
    return latestVersion;
  }

  async isInstalled() {
    if (!files.fileOrDirExists(this.gitFolder)) return false;

    return (await docker.compose.status(this.composeFile)).length ? true : false;
  }

  waitForContractsDeployment() {
    const retryTime = 1000;
    let elapsedTime = 0;
    const spinner = ora().start();
    const millisecondsToTime = (ms: number) => {
      const minutes = Math.floor(ms / 60000);
      const seconds = ((ms % 60000) / 1000).toFixed(0);
      return `${minutes}:${seconds.padStart(2, "0")}`;
    };
    const updateSpinner = () => {
      if (!spinner.isSpinning) return;
      spinner.text = `Deploying contracts... ${chalk.gray(`(Elapsed time: ${millisecondsToTime(elapsedTime)})`)}`;
    };
    updateSpinner();
    return new Promise<void>((resolve, reject) => {
      const interval = setInterval(async () => {
        elapsedTime += retryTime;

        try {
          const response = await fetch(`${this.nodeInfo.rpcUrl}/zks_getMainContract`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              method: "zks_getMainContract",
              params: [],
              id: 1,
            }),
          });

          if (response.ok) {
            const data = await response.json();
            if (data.result) {
              clearInterval(interval);
              spinner.succeed("Contracts deployed!");
              resolve();
            } else {
              Logger.debug("Received unexpected data from zks_getMainContract:", data);
            }
          } else {
            updateSpinner();
          }
        } catch (error) {
          updateSpinner();
          Logger.debug("Error while fetching zks_getMainContract:");
          Logger.debug(error);
        }

        const isNodeRunning = await this.isRunning();
        if (!isNodeRunning) {
          clearInterval(interval);
          spinner.fail("Deployment failed!");
          reject("Dockerized Node stopped running. Installation failed.");
        }
      }, retryTime);
    });
  }

  async install() {
    const latestVersion = await this.getLatestVersion();

    await git.cloneRepo(this.gitUrl, this.gitFolder);
    await docker.compose.up(this.composeFile); // using "up" instead of build since it might take a while for zkSync contracts to be deployed
    Logger.info(chalk.yellow("Waiting for zkSync contracts to be deployed... Usually it takes 5 - 15min..."));
    await this.waitForContractsDeployment();
    this.setModuleConfig({
      ...this.moduleConfig,
      version: latestVersion,
    });
  }

  async isRunning() {
    return (await docker.compose.status(this.composeFile)).some(({ isRunning }) => isRunning);
  }

  async start() {
    await docker.compose.up(this.composeFile);
  }

  getStartupInfo() {
    return [
      {
        text: "zkSync Node (L2):",
        list: [`Chain ID: ${this.nodeInfo.id}`, `RPC URL: ${this.nodeInfo.rpcUrl}`],
      },
      {
        text: "Ethereum Node (L1):",
        list: [`Chain ID: ${this.nodeInfo.l1Chain.id}`, `RPC URL: ${this.nodeInfo.l1Chain.rpcUrl}`],
      },
      `Rich accounts: ${path.join(this.gitFolder, "rich-wallets.json")}`,
    ];
  }

  async getLogs() {
    return await docker.compose.logs(this.composeFile);
  }

  async update() {
    await this.install();
  }

  async stop() {
    await docker.compose.stop(this.composeFile);
  }

  async clean() {
    await docker.compose.down(this.composeFile);
  }
}
