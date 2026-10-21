import type descriptorTypes from 'protobufjs/ext/descriptor/index.js';
import type * as protobuf from 'protobufjs';
import { nodeRequire } from '../../util/lazy-require.js';
import { ApsError } from '../../errors.js';

// the gRPC libraries load at first use, not at startup (see util/lazy-require.ts)
let grpcMod: typeof import('@grpc/grpc-js') | undefined;
let loaderMod: typeof import('@grpc/proto-loader') | undefined;
let protobufMod: typeof import('protobufjs') | undefined;
export const grpcJs = (): typeof import('@grpc/grpc-js') => (grpcMod ??= typeof require === 'function' ? require('@grpc/grpc-js') : nodeRequire('@grpc/grpc-js'));
export const protoLoaderLib = (): typeof import('@grpc/proto-loader') => (loaderMod ??= typeof require === 'function' ? require('@grpc/proto-loader') : nodeRequire('@grpc/proto-loader'));
export const protobufLib = (): typeof import('protobufjs') => (protobufMod ??= typeof require === 'function' ? require('protobufjs') : nodeRequire('protobufjs'));

// protobuf's descriptor extension loads at first use (see util/lazy-require.ts)
let descriptorMod: typeof descriptorTypes | undefined;
export const descriptorLib = (): typeof descriptorTypes => (descriptorMod ??= typeof require === 'function' ? require('protobufjs/ext/descriptor/index.js') : nodeRequire('protobufjs/ext/descriptor/index.js'));

/** A protobufjs Root from a FileDescriptorSet (base64). */
export function rootFromDescriptorSet(b64: string): protobuf.Root {
  try {
    const set = descriptorLib().FileDescriptorSet.decode(Buffer.from(b64, 'base64'));
    const root = (protobufLib().Root as unknown as { fromDescriptor(s: unknown): protobuf.Root }).fromDescriptor(set);
    root.resolveAll();
    return root;
  } catch (e) {
    throw new ApsError('ValidationError', `The reflected descriptors can't be used: ${(e as Error).message}`);
  }
}
