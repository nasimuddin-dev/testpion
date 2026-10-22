import { useRpc } from '../../lib/use-rpc';
import { Spinner } from '../ui';

interface Loaded {
  dataUri?: string;
  mime?: string;
  bytes?: number;
  width?: number;
  height?: number;
  sha256?: string;
  stripped?: boolean;
  problem?: string;
}

/**
 * The picture of a retrieved chunk in the drill-down. The window cannot read a file of the workspace or fetch a private
 * URL, so the backend reads it (`rag.image`: type by content, no SVG, size limit) and the window shows what comes back.
 * A picture that arrived inline is not kept in a result (only its hash is), and says so.
 */
export function ChunkImage({ image }: { image: string }) {
  const kept = /;sha256=/.test(image);
  const inline = /^data:image\//i.test(image) && !kept;
  const data = useRpc<Loaded>('rag.image', { ref: image }, { enabled: !kept && !inline });
  if (kept)
    return (
      <div className="text-muted mt-1" data-rag-chunk-image="hash">
        A picture came with this chunk. A result keeps its hash ({image.split('sha256=')[1]}), never the picture: run the target again to see it.
      </div>
    );
  if (!inline && !data)
    return (
      <div className="mt-1">
        <Spinner />
      </div>
    );
  const shown = inline ? image : data?.dataUri;
  if (!shown)
    return (
      <div className="text-warn mt-1" data-rag-chunk-image="problem">
        {data?.problem ?? 'The picture could not be read.'}
      </div>
    );
  return (
    <figure className="m-0 mt-1" data-rag-chunk-image="shown">
      <img src={shown} alt="A picture of this chunk" className="max-h-40 max-w-full object-contain rounded border border-line bg-surface" />
      {data?.bytes !== undefined && (
        <figcaption className="text-2xs text-muted mono">
          {data.mime} · {data.width && data.height ? `${data.width}×${data.height} · ` : ''}
          {Math.max(1, Math.round(data.bytes / 1024))} KB{data.stripped ? ' · metadata removed' : ''}
        </figcaption>
      )}
    </figure>
  );
}
