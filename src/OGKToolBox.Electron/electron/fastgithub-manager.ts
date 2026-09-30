import { app, session } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { X509Certificate } from "node:crypto";
import net from "node:net";
import path from "node:path";

const proxyHost = "127.0.0.1";
const proxyPort = 38457;
const proxyUrl = `http://${proxyHost}:${proxyPort}`;
const proxyPartition = "ogk-github";

/**
 * Runs the embedded FastGithub build for GitHub traffic in an isolated
 * Electron session. It never changes the Windows system proxy or certificate
 * store.
 */
export class FastGithubManager {
  private process?: ChildProcess;
  private startPromise?: Promise<boolean>;
  private caCertificate?: X509Certificate;
  lastError?: string;

  // Package downloads and application updates must not change each other's route.
  async configureUpdater(useFastGithub: boolean): Promise<void> {
    if (useFastGithub && !await this.enable()) {
      throw new Error(this.lastError || "FastGithub 启动失败");
    }
    const target = session.fromPartition("electron-updater", { cache: false });
    await target.closeAllConnections();
    await target.setProxy(useFastGithub
      ? { proxyRules: `http=${proxyUrl};https=${proxyUrl}`, proxyBypassRules: "<local>" }
      : { mode: "direct" });
    target.setCertificateVerifyProc(useFastGithub ? (request, callback) => {
      const trusted = isTrustedFastGithubCertificate(request.hostname, request.certificate.data, this.caCertificate);
      callback(trusted || request.verificationResult === "OK" ? 0 : -2);
    } : null);
  }

  async enable(): Promise<boolean> {
    if (process.platform !== "win32") { this.lastError = "FastGithub 仅支持 Windows"; return false; }

    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startAndConfigure();
    try {
      return await this.startPromise;
    } finally {
      this.startPromise = undefined;
    }
  }

  async disable(): Promise<void> {
    try {
      await this.startPromise;
      this.startPromise = undefined;
      for (const partition of ["electron-updater", proxyPartition]) {
        try {
          const target = session.fromPartition(partition, { cache: false });
          await target.closeAllConnections();
          target.setCertificateVerifyProc(null);
          await target.setProxy({ mode: "direct" });
        } catch {
          // A session may already be closing; still stop the owned child process.
        }
      }
    } finally { await this.stopProcess(); }
  }

  async fetch(input: string, init?: RequestInit, requireProxy = false): Promise<Response> {
    if (!await this.enable()) {
      if (requireProxy) throw new Error(this.lastError || "FastGithub 启动失败");
      return globalThis.fetch(input, init);
    }
    const githubSession = session.fromPartition(proxyPartition, { cache: false });
    return githubSession.fetch(input, init);
  }

  private async startAndConfigure(): Promise<boolean> {
    this.lastError = undefined;
    const executable = path.join(process.resourcesPath, "fastgithub", "fastgithub.exe");
    if (!existsSync(executable)) { this.lastError = "安装目录缺少 fastgithub/fastgithub.exe"; return false; }

    if (!this.process || this.process.killed || this.process.exitCode !== null) {
      const dataRoot = path.join(app.getPath("userData"), "fastgithub");
      try {
        await mkdir(dataRoot, { recursive: true });
      } catch (error) {
        this.lastError = `无法创建 FastGithub 数据目录：${error instanceof Error ? error.message : String(error)}`;
        return false;
      }
      const child = spawn(executable, [
        "FastGithub:Embedded=true",
        `ParentProcessId=${process.pid}`,
        `DataRoot=${dataRoot}`
      ], {
        cwd: path.dirname(executable),
        detached: false,
        stdio: "ignore",
        windowsHide: true
      });
      this.process = child;
      child.on("error", error => { this.lastError = `FastGithub 进程错误：${error.message}`; });
    }

    if (!await this.waitUntilReady(this.process)) {
      this.lastError ||= "FastGithub 本地代理未就绪（端口 38457），进程可能退出或启动超时";
      await this.stopProcess();
      return false;
    }

    const dataRoot = path.join(app.getPath("userData"), "fastgithub");
    let caCertificate: X509Certificate;
    try {
      caCertificate = new X509Certificate(await readFile(path.join(dataRoot, "cacert", "fastgithub.cer")));
    } catch {
      this.lastError = "FastGithub 本地证书未生成或无法读取";
      await this.stopProcess();
      return false;
    }

    const updaterSession = session.fromPartition(proxyPartition, { cache: false });
    try {
      await updaterSession.setProxy({
        proxyRules: `http=${proxyUrl};https=${proxyUrl}`,
        proxyBypassRules: "<local>"
      });
      updaterSession.setCertificateVerifyProc((request, callback) => {
        const embeddedCertificate =
          isTrustedFastGithubCertificate(request.hostname, request.certificate.data, caCertificate);
        callback(embeddedCertificate || request.verificationResult === "OK" ? 0 : -2);
      });
      this.caCertificate = caCertificate;
      return true;
    } catch {
      this.lastError = "无法配置 FastGithub 的 Electron 代理会话";
      await this.stopProcess();
      return false;
    }
  }

  private async waitUntilReady(child: ChildProcess): Promise<boolean> {
    let exited = false;
    const onExit = () => { exited = true; };
    child.once("exit", onExit);
    child.once("error", onExit);

    try {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (exited) return false;
        if (await canConnect(proxyHost, proxyPort)) return true;
        await delay(100);
      }
      return false;
    } finally {
      child.removeListener("exit", onExit);
      child.removeListener("error", onExit);
    }
  }

  private async stopProcess(): Promise<void> {
    const child = this.process;
    this.process = undefined;
    if (!child || child.exitCode !== null) return;

    child.kill();
    await Promise.race([onceExit(child), delay(1500)]);
  }
}

export const fastGithubManager = new FastGithubManager();

function isGithubHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "github.com" || host.endsWith(".github.com") ||
    host.endsWith(".githubusercontent.com") || host.endsWith(".githubassets.com");
}

function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.createConnection({ host, port });
    const finish = (connected: boolean) => {
      socket.destroy();
      resolve(connected);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(250, () => finish(false));
  });
}

function onceExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise(resolve => child.once("exit", () => resolve()));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

// FastGithub can send only its leaf certificate, so Electron's issuerCert may be absent.
// Verify the actual signature against our own CA instead of trusting the issuer's name.
export function isTrustedFastGithubCertificate(hostname: string, pem: string, ca?: X509Certificate, now = Date.now()): boolean {
  if (!ca || !isGithubHost(hostname)) return false;
  try {
    const certificate = new X509Certificate(pem);
    const valid = (value: X509Certificate) => now >= Date.parse(value.validFrom) && now <= Date.parse(value.validTo);
    return ca.ca && valid(ca) && valid(certificate) && !!certificate.checkHost(hostname) &&
      certificate.checkIssued(ca) && certificate.verify(ca.publicKey);
  } catch { return false; }
}
