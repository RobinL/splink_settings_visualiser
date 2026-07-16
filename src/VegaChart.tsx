import { useEffect, useRef, useState } from "react";
import embed, { type VisualizationSpec } from "vega-embed";

export function VegaChart({
  spec,
  label,
  className,
}: {
  spec: VisualizationSpec;
  label: string;
  className?: string;
}) {
  const target = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!target.current) return;
    let view: { finalize: () => void } | undefined;
    setError(undefined);
    embed(target.current, spec, { actions: false, renderer: "canvas" })
      .then((result) => {
        view = result.view;
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : "The chart could not be rendered.");
      });
    return () => view?.finalize();
  }, [spec]);

  if (error) return <div className="inline-error">{error}</div>;
  return (
    <div
      ref={target}
      className={`vega-chart${className ? ` ${className}` : ""}`}
      role="img"
      aria-label={label}
    />
  );
}