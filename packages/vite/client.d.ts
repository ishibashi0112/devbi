declare module "virtual:devbi" {
  import type { ProjectInput } from "@devbi/react";
  const project: ProjectInput;
  export default project;
}

declare module "virtual:devbi/embed" {
  import type { DevbiEmbed } from "@devbi/react";
  const devbi: DevbiEmbed;
  export default devbi;
  export const dashboards: DevbiEmbed["dashboards"];
  export const mount: DevbiEmbed["mount"];
  export const mountAll: DevbiEmbed["mountAll"];
  export const unmount: DevbiEmbed["unmount"];
}
