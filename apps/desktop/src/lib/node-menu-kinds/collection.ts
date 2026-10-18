import { FolderCog, Link2, Settings2, Terminal, Wand2 } from 'lucide-react';
import type { ActionDef } from '../node-menu-actions';
import { LABEL } from '../vocabulary';

/** The actions of the Collections tree's own kinds (collection, its folders, requests, gRPC calls, connections). */
export const COLLECTION_ACTIONS: readonly ActionDef[] = [
  { id: 'collectionSettings', group: 'tools', label: LABEL.collectionSettings, icon: Settings2, kinds: ['collection'] },
  { id: 'convertScripts', group: 'tools', label: LABEL.convertScriptsTp, icon: Wand2, kinds: ['collection'] },
  { id: 'copyGrpcurl', group: 'share', label: LABEL.copyGrpcurl, icon: Terminal, kinds: ['grpc-call'] },
  { id: 'copyUrl', group: 'share', label: LABEL.copyUrl, icon: Link2, kinds: ['ws-connection'] },
  { id: 'editFolder', group: 'tools', label: LABEL.editFolder, icon: FolderCog, kinds: ['folder'] },
];
