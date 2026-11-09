import type { Pinned } from './download';
import { machineArch } from './machine';

/**
 * Everything DoCatz downloads for the engine, pinned by version and SHA-256 (DoCatz TODO #2 / #7 / #34). Every
 * entry exists for Apple silicon, Intel Macs, Windows x64 and Linux x64 / ARM64 — DoCatz ships the Intel build from
 * its first release; on Linux only the CLIs (the engine is the system's Docker, #101).
 * Bumping a version means updating its checksums here (from the project's own SHA256SUMS / .sha256 files).
 */

type Arch = 'arm64' | 'x64';
type Os = 'mac' | 'win' | 'linux';

export const VERSIONS = { lima: '2.2.1', docker: '29.9.2', compose: '5.6.1', buildx: '0.38.1', alpine: '3.24.3' } as const;

const LIMA: Record<Arch, Pinned> = {
  arm64: { name: `lima-${VERSIONS.lima}-Darwin-arm64.tar.gz`, url: `https://github.com/lima-vm/lima/releases/download/v${VERSIONS.lima}/lima-${VERSIONS.lima}-Darwin-arm64.tar.gz`, sha256: '9e9eacce88f37e185c346bad73aa6136f738d8cdf8c3bb23cd42b071824bc66e' },
  x64: { name: `lima-${VERSIONS.lima}-Darwin-x86_64.tar.gz`, url: `https://github.com/lima-vm/lima/releases/download/v${VERSIONS.lima}/lima-${VERSIONS.lima}-Darwin-x86_64.tar.gz`, sha256: '6b776e4bc41f358e6ee01fefcc78e2eb26f11635a0fcff632234af77a566c6c4' },
};

const DOCKER: Record<`${Os}-${Arch}`, Pinned | null> = {
  'mac-arm64': { name: `docker-${VERSIONS.docker}-mac-arm64.tgz`, url: `https://download.docker.com/mac/static/stable/aarch64/docker-${VERSIONS.docker}.tgz`, sha256: 'ea8a2ce5ac31f9f5f3fb711a7a485e1e46cc7a69798a629a70306f6e6af25b7a' },
  'mac-x64': { name: `docker-${VERSIONS.docker}-mac-x64.tgz`, url: `https://download.docker.com/mac/static/stable/x86_64/docker-${VERSIONS.docker}.tgz`, sha256: '089c3f618df88bdef4f1257d9d604499136a1ec5168b67d194c260acad2b522f' },
  'win-x64': { name: `docker-${VERSIONS.docker}-win-x64.zip`, url: `https://download.docker.com/win/static/stable/x86_64/docker-${VERSIONS.docker}.zip`, sha256: 'b2be959bfed1281ddaf665c0972cba9a62ce30c542b6bcce82f055bf8886bc7d' },
  'win-arm64': null,
  'linux-x64': { name: `docker-${VERSIONS.docker}-linux-x64.tgz`, url: `https://download.docker.com/linux/static/stable/x86_64/docker-${VERSIONS.docker}.tgz`, sha256: '9ac225999fd5e863f7694c728ef23d480616b1e5639328fa309befd4243d69eb' },
  'linux-arm64': { name: `docker-${VERSIONS.docker}-linux-arm64.tgz`, url: `https://download.docker.com/linux/static/stable/aarch64/docker-${VERSIONS.docker}.tgz`, sha256: '873b3e0207857c3b2f28392fb922f3ea6efe37620c16d4d4aaf2fef409c90b73' },
};

const COMPOSE: Record<`${Os}-${Arch}`, Pinned | null> = {
  'mac-arm64': { name: `docker-compose-${VERSIONS.compose}-darwin-aarch64`, url: `https://github.com/docker/compose/releases/download/v${VERSIONS.compose}/docker-compose-darwin-aarch64`, sha256: 'fcce41226abd2b7b2936094e688bbd61284673dddafea542e08cb9a3b4423a8b' },
  'mac-x64': { name: `docker-compose-${VERSIONS.compose}-darwin-x86_64`, url: `https://github.com/docker/compose/releases/download/v${VERSIONS.compose}/docker-compose-darwin-x86_64`, sha256: '245c191b11a6345dd3b32b8f6eadeed1e1dcd5147aa46dfa423462e95f587e93' },
  'win-x64': { name: `docker-compose-${VERSIONS.compose}-windows-x86_64.exe`, url: `https://github.com/docker/compose/releases/download/v${VERSIONS.compose}/docker-compose-windows-x86_64.exe`, sha256: '91b1492f0a923427651e2b955739d732ac36b8191193bf4799e62f3e3525c4cd' },
  'win-arm64': null,
  'linux-x64': { name: `docker-compose-${VERSIONS.compose}-linux-x86_64`, url: `https://github.com/docker/compose/releases/download/v${VERSIONS.compose}/docker-compose-linux-x86_64`, sha256: '47737f4236e6d3ccea7291995203f8f018058783b4c3a9469119811a0b5db8c0' },
  'linux-arm64': { name: `docker-compose-${VERSIONS.compose}-linux-aarch64`, url: `https://github.com/docker/compose/releases/download/v${VERSIONS.compose}/docker-compose-linux-aarch64`, sha256: '42cfa75f51ad0ccf290bad37899e0038a8c10a0069e85233ecc1d53e3ff1347d' },
};

const BUILDX: Record<`${Os}-${Arch}`, Pinned | null> = {
  'mac-arm64': { name: `buildx-v${VERSIONS.buildx}.darwin-arm64`, url: `https://github.com/docker/buildx/releases/download/v${VERSIONS.buildx}/buildx-v${VERSIONS.buildx}.darwin-arm64`, sha256: '6f20ba2437865311ef99015bf5d1039c3c8e4d2177c1c64aa41b134b5ecd3012' },
  'mac-x64': { name: `buildx-v${VERSIONS.buildx}.darwin-amd64`, url: `https://github.com/docker/buildx/releases/download/v${VERSIONS.buildx}/buildx-v${VERSIONS.buildx}.darwin-amd64`, sha256: '76e7a809cc98d34a4c1b7db23feac673def5b8dcdddd9e713ef26598689aa796' },
  'win-x64': { name: `buildx-v${VERSIONS.buildx}.windows-amd64.exe`, url: `https://github.com/docker/buildx/releases/download/v${VERSIONS.buildx}/buildx-v${VERSIONS.buildx}.windows-amd64.exe`, sha256: 'fd2e18501910dd535ea3aa7f69010b3cfdfba0f47aa27674124554386dfa26f3' },
  'win-arm64': null,
  'linux-x64': { name: `buildx-v${VERSIONS.buildx}.linux-amd64`, url: `https://github.com/docker/buildx/releases/download/v${VERSIONS.buildx}/buildx-v${VERSIONS.buildx}.linux-amd64`, sha256: 'e25d5cd675092bb5d1d03632fdc46cdf3fede7b514dc5f023a105e00d3ce5ad4' },
  'linux-arm64': { name: `buildx-v${VERSIONS.buildx}.linux-arm64`, url: `https://github.com/docker/buildx/releases/download/v${VERSIONS.buildx}/buildx-v${VERSIONS.buildx}.linux-arm64`, sha256: '3b83b3731916ba433feccaaa689fe5bcdc81c641d92c8e6c2ea865dfa141c97a' },
};

/**
 * The WSL guest on Windows (DoCatz TODO #2 / #29): Alpine's minimal root file system; dockerd comes from apk. Its arch
 * is the PC's own (machine.ts): a Windows ARM PC runs WSL on arm64 even when DoCatz itself is the emulated x64 build.
 */
const alpineUrl = (a: string) => `https://dl-cdn.alpinelinux.org/alpine/v${VERSIONS.alpine.split('.').slice(0, 2).join('.')}/releases/${a}/alpine-minirootfs-${VERSIONS.alpine}-${a}.tar.gz`;
const ALPINE_WSL: Record<Arch, Pinned> = {
  x64: { name: `alpine-minirootfs-${VERSIONS.alpine}-x86_64.tar.gz`, url: alpineUrl('x86_64'), sha256: 'f8e1cafba9b1b283b5d30d06f9885c8d2bc161ffe9083ade8e2e157813a53407' },
  arm64: { name: `alpine-minirootfs-${VERSIONS.alpine}-aarch64.tar.gz`, url: alpineUrl('aarch64'), sha256: '4d3f80afaebd447c5591a63a73bde380a149fe8b2d85488cafabb2ff97551f50' },
};

const arch = (): Arch => (process.arch === 'arm64' ? 'arm64' : 'x64');
const os = (): Os => (process.platform === 'win32' ? 'win' : process.platform === 'linux' ? 'linux' : 'mac');
const need = (p: Pinned | null, what: string): Pinned => {
  if (!p) throw new Error(`There is no ${what} build for this computer (${process.platform} ${process.arch})`);
  return p;
};

export const limaPackage = () => LIMA[arch()];
export const dockerPackage = () => need(DOCKER[`${os()}-${arch()}`], 'Docker CLI');
export const composePackage = () => need(COMPOSE[`${os()}-${arch()}`], 'Docker Compose');
export const buildxPackage = () => need(BUILDX[`${os()}-${arch()}`], 'Docker Buildx');
export const wslRootfs = () => ALPINE_WSL[machineArch()];
