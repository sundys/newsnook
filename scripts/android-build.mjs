import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

import { javaExecutable, loadAndroidEnv } from './android-env.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const androidRoot = join(projectRoot, 'android')
const format = process.argv[2]
const flavorArgument = process.argv[3] ?? 'all'
const abiArgument = process.argv[4] ?? 'all'
const supportedFlavors = ['cloud', 'local']
const supportedAbis = ['arm64-v8a', 'armeabi-v7a', 'x86_64']
const localSupportedAbis = ['arm64-v8a']

if (format !== 'apk' && format !== 'aab') {
  throw new Error('Usage: node scripts/android-build.mjs <apk|aab> [cloud|local|all] [arm64-v8a|armeabi-v7a|x86_64|all]')
}
if (flavorArgument !== 'all' && !supportedFlavors.includes(flavorArgument)) {
  throw new Error('Flavor must be cloud, local, or all.')
}
if (abiArgument !== 'all' && !supportedAbis.includes(abiArgument)) {
  throw new Error('ABI must be arm64-v8a, armeabi-v7a, x86_64, or all.')
}
if (format === 'aab' && abiArgument !== 'all') {
  throw new Error('AAB is a Play distribution bundle and must be built with ABI=all.')
}

const flavors = flavorArgument === 'all' ? supportedFlavors : [flavorArgument]
const targets =
  format === 'aab'
    ? flavors.map((flavor) => ({ flavor, abi: null }))
    : flavors.flatMap((flavor) => {
        const allowedAbis = flavor === 'local' ? localSupportedAbis : supportedAbis
        const abis = abiArgument === 'all' ? allowedAbis : [abiArgument]
        if (abis.some((abi) => !allowedAbis.includes(abi))) {
          throw new Error(`The ${flavor} flavor only supports: ${allowedAbis.join(', ')}.`)
        }
        return abis.map((abi) => ({ flavor, abi }))
      })

const env = loadAndroidEnv(projectRoot)
const requiredSigningVariables = [
  'NEWSNOOK_KEYSTORE_FILE',
  'NEWSNOOK_KEYSTORE_PASSWORD',
  'NEWSNOOK_KEY_ALIAS',
  'NEWSNOOK_KEY_PASSWORD',
]
const missingSigningVariables = requiredSigningVariables.filter((key) => !env[key])
if (missingSigningVariables.length) {
  throw new Error(
    `Release signing is missing (${missingSigningVariables.join(', ')}). Run npm run android:keystore:init first.`,
  )
}
if (!existsSync(env.NEWSNOOK_KEYSTORE_FILE)) {
  throw new Error(`Release keystore not found: ${env.NEWSNOOK_KEYSTORE_FILE}`)
}

if (targets.some(({ flavor }) => flavor === 'local')) {
  const bergamotCmake = join(
    androidRoot,
    'app',
    'src',
    'local',
    'cpp',
    'third_party',
    'bergamot-translator',
    'CMakeLists.txt',
  )
  if (!existsSync(bergamotCmake)) {
    console.log('Local flavor requires bergamot-translator. Running bergamot:init…')
    const initResult = spawnSync(
      process.execPath,
      [join(projectRoot, 'scripts', 'bergamot-init.mjs')],
      { stdio: 'inherit' },
    )
    if (initResult.status !== 0) process.exit(initResult.status ?? 1)
  }
}

const packageJson = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'))
const outputDirectory = join(projectRoot, 'artifacts', 'android')
mkdirSync(outputDirectory, { recursive: true })
const apksignerJar = format === 'apk' ? findApksignerJar(env.ANDROID_HOME) : null
const taskPrefix = format === 'apk' ? 'assemble' : 'bundle'

for (const { flavor, abi } of targets) {
  const task = `${taskPrefix}${flavor[0].toUpperCase()}${flavor.slice(1)}Release`
  const targetLabel = abi ?? 'all ABI'
  console.log(`Building ${flavor} ${targetLabel} ${format.toUpperCase()}…`)
  const result = spawnSync(
    javaExecutable(env.JAVA_HOME),
    [
      '-Dorg.gradle.appname=gradlew',
      '-classpath',
      '',
      '-jar',
      join(androidRoot, 'gradle', 'wrapper', 'gradle-wrapper.jar'),
      task,
      ...(abi ? [`-PnewsnookAbi=${abi}`] : []),
      '--no-daemon',
      '--console=plain',
      '--stacktrace',
    ],
    { cwd: androidRoot, env, stdio: 'inherit' },
  )
  if (result.status !== 0) process.exit(result.status ?? 1)

  const source =
    format === 'apk'
      ? join(androidRoot, 'app', 'build', 'outputs', 'apk', flavor, 'release', `app-${flavor}-release.apk`)
      : join(androidRoot, 'app', 'build', 'outputs', 'bundle', `${flavor}Release`, `app-${flavor}-release.aab`)
  if (!existsSync(source)) {
    throw new Error(`Gradle completed but the expected artifact is missing: ${source}`)
  }

  const destination = join(
    outputDirectory,
    `newsnook-${packageJson.version}-${flavor}${abi ? `-${abi}` : ''}-release.${format}`,
  )
  copyFileSync(source, destination)

  if (format === 'apk') {
    verify(
      javaExecutable(env.JAVA_HOME),
      ['-jar', apksignerJar, 'verify', '--verbose', '--print-certs', destination],
      env,
      `${flavor} ${targetLabel} APK signature verification failed`,
    )
  } else {
    verify(
      javaExecutable(env.JAVA_HOME, 'jarsigner'),
      ['-verify', '-certs', destination],
      env,
      `${flavor} ${targetLabel} AAB signature verification failed`,
      true,
    )
  }

  const sizeMiB = (statSync(destination).size / 1024 / 1024).toFixed(2)
  console.log(`Android ${flavor} ${targetLabel} ${format.toUpperCase()} ready: ${destination} (${sizeMiB} MiB)`)
}

function findApksignerJar(androidHome) {
  const buildToolsRoot = join(androidHome, 'build-tools')
  const directory = readdirSync(buildToolsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse()
    .find((name) =>
      existsSync(
        join(
          buildToolsRoot,
          name,
          process.platform === 'win32' ? 'apksigner.bat' : 'apksigner',
        ),
      ),
    )
  if (!directory) throw new Error(`apksigner not found under ${buildToolsRoot}`)
  return join(buildToolsRoot, directory, 'lib', 'apksigner.jar')
}

function verify(command, args, commandEnv, errorMessage, quiet = false) {
  const verification = spawnSync(command, args, {
    encoding: quiet ? 'utf8' : undefined,
    env: commandEnv,
    stdio: quiet ? 'pipe' : 'inherit',
  })
  if (verification.status !== 0) {
    if (quiet) {
      process.stderr.write(verification.stdout ?? '')
      process.stderr.write(verification.stderr ?? '')
    }
    throw new Error(errorMessage)
  }
  if (quiet) console.log('AAB signature verified.')
}
