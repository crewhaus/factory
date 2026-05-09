/**
 * Wraps @crewhaus/scaffold-templates for the playground's "new spec"
 * picker. The picker shows the title + description; clicking a template
 * loads the YAML into the Monaco editor.
 */
import { TEMPLATES, type Template } from "@crewhaus/scaffold-templates";

export type TemplateMenuEntry = {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly target: string;
  readonly yaml: string;
};

export function templateMenuEntries(): readonly TemplateMenuEntry[] {
  return TEMPLATES.map(
    (t: Template): TemplateMenuEntry => ({
      id: t.id,
      title: t.title,
      description: t.description,
      target: t.target,
      yaml: t.yaml,
    }),
  );
}
