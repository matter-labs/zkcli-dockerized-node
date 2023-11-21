import chalk from "chalk";
import ora from "ora";
import path from "path";
import { ModuleNode, files, git, docker, Logger } from "zksync-cli/lib";

import type { ConfigHandler } from "zksync-cli/lib";

export default class SetupModule extends ModuleNode {
  constructor(config: ConfigHandler) {
    super(
      {
        name: "Dockerized node",
        description: "Persistent state, includes L1 and L2 nodes",
      },
      config
    );
  }

  gitUrl = "https://github.com/matter-labs/local-setup.git";
  get gitFolder() {
    return path.join(this.dataDirPath, "./local-setup");
  }
  get composeFile() {
    return path.join(this.gitFolder, "docker-compose.yml");
  }

  get nodeInfo() {
    return {
      l1: {
        chainId: 9,
        rpcUrl: "http://localhost:8545",
      },
      l2: {
        chainId: 270,
        rpcUrl: "http://localhost:3050",
      },
    };
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
          const response = await fetch(`${this.nodeInfo.l2.rpcUrl}/zks_getMainContract`, {
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
    await git.cloneRepo(this.gitUrl, this.gitFolder);
    await docker.compose.up(this.composeFile); // using "up" instead of build since it might take a while for zkSync contracts to be deployed
    Logger.info(chalk.yellow("Waiting for zkSync contracts to be deployed... Usually it takes 5 - 15min..."));
    await this.waitForContractsDeployment();
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
        list: [`Chain ID: ${this.nodeInfo.l2.chainId}`, `RPC URL: ${this.nodeInfo.l2.rpcUrl}`],
      },
      {
        text: "Ethereum Node (L1):",
        list: [`Chain ID: ${this.nodeInfo.l1.chainId}`, `RPC URL: ${this.nodeInfo.l1.rpcUrl}`],
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
