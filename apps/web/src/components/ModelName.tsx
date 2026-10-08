import { formatModel, modelTitle } from '@/lib/model-name';

/** A model id shown as its friendly name ("Opus 5.5") with the raw id on hover; "—" when missing. */
export function ModelName({ id, className }: { id: string | null | undefined; className?: string }) {
  if (!id) return <>—</>;
  return (
    <span className={className} title={modelTitle(id)}>
      {formatModel(id)}
    </span>
  );
}
