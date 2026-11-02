import type { Pinned } from './download';

/**
 * Everything DoCatz downloads for the engine, pinned by version and SHA-256 (DoCatz TODO #2 / #7 / #34). Every
 * entry exists for Apple silicon, Intel Macs and Windows x64 — DoCatz ships the Intel build from its first release.
 * Bumping a version means updating its checksums here (from the project's own SHA256SUMS / .sha256 files).
 */

type Arch = 'arm64' | 'x64';
type Os = 'mac' | 'win';

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
};

const COMPOSE: Record<`${Os}-${Arch}`, Pinned | null> = {
  'mac-arm64': { name: `docker-compose-${VERSIONS.compose}-darwin-aarch64`, url: `https://github.com/docker/compose/releases/download/v${VERSIONS.compose}/docker-compose-darwin-aarch64`, sha256: 'fcce41226abd2b7b2936094e688bbd61284673dddafea542e08cb9a3b4423a8b' },
  'mac-x64': { name: `docker-compose-${VERSIONS.compose}-darwin-x86_64`, url: `https://github.com/docker/compose/releases/download/v${VERSIONS.compose}/docker-compose-darwin-x86_64`, sha256: '245c191b11a6345dd3b32b8f6eadeed1e1dcd5147aa46dfa423462e95f587e93' },
  'win-x64': { name: `docker-compose-${VERSIONS.compose}-windows-x86_64.exe`, url: `https://github.com/docker/compose/releases/download/v${VERSIONS.compose}/docker-compose-windows-x86_64.exe`, sha256: '91b1492f0a923427651e2b955739d732ac36b8191193bf4799e62f3e3525c4cd' },
  'win-arm64': null,
};

const BUILDX: Record<`${Os}-${Arch}`, Pinned | null> = {
  'mac-arm64': { name: `buildx-v${VERSIONS.buildx}.darwin-arm64`, url: `https://github.com/docker/buildx/releases/download/v${VERSIONS.buildx}/buildx-v${VERSIONS.buildx}.darwin-arm64`, sha256: '6f20ba2437865311ef99015bf5d1039c3c8e4d2177c1c64aa41b134b5ecd3012' },
  'mac-x64': { name: `buildx-v${VERSIONS.buildx}.darwin-amd64`, url: `https://github.com/docker/buildx/releases/download/v${VERSIONS.buildx}/buildx-v${VERSIONS.buildx}.darwin-amd64`, sha256: '76e7a809cc98d34a4c1b7db23feac673def5b8dcdddd9e713ef26598689aa796' },
  'win-x64': { name: `buildx-v${VERSIONS.buildx}.windows-amd64.exe`, url: `https://github.com/docker/buildx/releases/download/v${VERSIONS.buildx}/buildx-v${VERSIONS.buildx}.windows-amd64.exe`, sha256: 'fd2e18501910dd535ea3aa7f69010b3cfdfba0f47aa27674124554386dfa26f3' },
  'win-arm64': null,
};

/** The WSL guest on Windows (DoCatz TODO #2 / #29): Alpine's minimal root file system; dockerd comes from apk. */
const ALPINE_WSL: Pinned = {
  name: `alpine-minirootfs-${VERSIONS.alpine}-x86_64.tar.gz`,
  url: `https://dl-cdn.alpinelinux.org/alpine/v${VERSIONS.alpine.split('.').slice(0, 2).join('.')}/releases/x86_64/alpine-minirootfs-${VERSIONS.alpine}-x86_64.tar.gz`,
  sha256: 'f8e1cafba9b1b283b5d30d06f9885c8d2bc161ffe9083ade8e2e157813a53407',
};

const arch = (): Arch => (process.arch === 'arm64' ? 'arm64' : 'x64');
const os = (): Os => (process.platform === 'win32' ? 'win' : 'mac');
const need = (p: Pinned | null, what: string): Pinned => {
  if (!p) throw new Error(`There is no ${what} build for this computer (${process.platform} ${process.arch})`);
  return p;
};

export const limaPackage = () => LIMA[arch()];
export const dockerPackage = () => need(DOCKER[`${os()}-${arch()}`], 'Docker CLI');
export const composePackage = () => need(COMPOSE[`${os()}-${arch()}`], 'Docker Compose');
export const buildxPackage = () => need(BUILDX[`${os()}-${arch()}`], 'Docker Buildx');
export const wslRootfs = () => ALPINE_WSL;
