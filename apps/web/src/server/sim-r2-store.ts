import type { SimPrivateAssetStore } from './sim-private-assets'

/**
 * The storage adapter that lets the hosted Agent Sim read its private export from an R2 bucket.
 *
 * It is the narrow half of the private-asset contract: given the named location and a key the
 * reader has already validated, it asks the bucket binding for that one object and hands back the
 * bytes and a content type. That is all it can do. The bucket type below has a single method, so
 * this module cannot list, write, delete, sign a URL or build a public address, and a bucket value
 * that offers more is not given any more power by being passed in.
 *
 * What this module does not decide: whether the bucket is private. The access control list, the
 * absence of an `r2.dev` or custom-domain alias, and who else can read the objects are deployment
 * prerequisites listed in docs/plans/hosted-sim-approved-service-composition.md. Nothing here
 * proves them, and local tests with a fake bucket cannot either.
 */

/** The part of an R2 object this adapter reads. */
export type SimR2Object = Readonly<{
  body?: ReadableStream | null
  httpMetadata?: Readonly<{ contentType?: string }> | undefined
}>

/** The one bucket operation the adapter uses. The platform's `R2Bucket` satisfies it. */
export type SimR2Bucket = Readonly<{
  get(key: string): Promise<SimR2Object | null>
}>

/**
 * Content types for the file kinds an export carries, used only when an object was uploaded without
 * one. The reader refuses an answer with no content type, and an octet-stream script is not run by
 * a browser that is told not to sniff, so a missing type is filled from the extension. An unknown
 * extension stays `application/octet-stream`, which a browser downloads rather than runs.
 */
const CONTENT_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  js: 'text/javascript',
  mjs: 'text/javascript',
  json: 'application/json',
  wasm: 'application/wasm',
  css: 'text/css',
  txt: 'text/plain',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  glb: 'model/gltf-binary',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
}

const FALLBACK_CONTENT_TYPE = 'application/octet-stream'

function contentTypeFor(key: string, stored: string | undefined): string {
  if (typeof stored === 'string' && stored.length > 0) return stored
  const dot = key.lastIndexOf('.')
  const extension = dot === -1 ? '' : key.slice(dot + 1).toLowerCase()
  return Object.hasOwn(CONTENT_TYPE_BY_EXTENSION, extension)
    ? CONTENT_TYPE_BY_EXTENSION[extension]!
    : FALLBACK_CONTENT_TYPE
}

/**
 * Builds the private-asset store for one bucket and the one location name it holds.
 *
 * A request for any other location answers as absent and the bucket is not asked, so a store built
 * for the export cannot be pointed at a second location by a caller. An absent object answers
 * `null`. A bucket that fails throws, and so does an object that comes back without a body: neither
 * is "absent", and the caller serves nothing rather than an empty file that looks like a success.
 */
export function createSimR2AssetStore(options: {
  /** The location name the reader passes with every key. */
  location: string
  /** The bucket binding that holds that location's objects. */
  bucket: SimR2Bucket
}): SimPrivateAssetStore {
  const { location, bucket } = options
  return async (request) => {
    if (request.location !== location) return null
    const object = await bucket.get(request.key)
    if (object === null || object === undefined) return null
    if (!object.body) {
      throw new Error('the R2 object came back without a body')
    }
    return {
      body: object.body,
      contentType: contentTypeFor(request.key, object.httpMetadata?.contentType),
    }
  }
}
