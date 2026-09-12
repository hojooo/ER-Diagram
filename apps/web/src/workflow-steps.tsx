export function WorkflowSteps({
  steps,
  current,
}: {
  readonly steps: readonly [string, string, string];
  readonly current: 0 | 1 | 2;
}) {
  return (
    <ol className="ui-workflow-steps">
      {steps.map((label, index) => (
        <li key={label} aria-current={index === current ? "step" : undefined}>
          <span aria-hidden="true">{index + 1}.</span>
          {label}
        </li>
      ))}
    </ol>
  );
}
