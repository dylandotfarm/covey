/** One-line human summaries for tool calls, in the style of Claude Code's own UI. */
export function summariseTool(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, any>;
  const short = (s: unknown, n = 80) => {
    const str = String(s ?? "").replace(/\s+/g, " ").trim();
    return str.length > n ? str.slice(0, n - 1) + "…" : str;
  };
  switch (name) {
    case "Read": return `Read ${short(i.file_path)}`;
    case "Write": return `Write ${short(i.file_path)}`;
    case "Edit": return `Edit ${short(i.file_path)}`;
    case "MultiEdit": return `Edit ${short(i.file_path)}`;
    case "NotebookEdit": return `Edit notebook ${short(i.notebook_path)}`;
    case "Bash": return i.description ? `${short(i.description)}` : `$ ${short(i.command)}`;
    case "Grep": return `Grep ${short(i.pattern)}${i.path ? ` in ${short(i.path, 40)}` : ""}`;
    case "Glob": return `Glob ${short(i.pattern)}`;
    case "LS": return `List ${short(i.path)}`;
    case "WebFetch": return `Fetch ${short(i.url)}`;
    case "WebSearch": return `Search ${short(i.query)}`;
    case "Task":
    case "Agent": return `Agent: ${short(i.description ?? i.prompt, 70)}`;
    case "TodoWrite": return `Update todos`;
    case "AskUserQuestion": return `Question`;
    case "ExitPlanMode": return `Plan ready for review`;
    case "EnterPlanMode": return `Enter plan mode`;
    case "Skill": return `Skill ${short(i.skill)}`;
    default:
      if (name.startsWith("mcp__")) {
        const parts = name.split("__");
        return `${parts[1]}: ${parts.slice(2).join("__")}`;
      }
      return `${name} ${short(JSON.stringify(i), 60)}`;
  }
}

export function toolIcon(name: string): string {
  switch (name) {
    case "Read": case "Glob": case "Grep": case "LS": return "◇";
    case "Write": case "Edit": case "MultiEdit": case "NotebookEdit": return "✎";
    case "Bash": return "$";
    case "WebFetch": case "WebSearch": return "⇣";
    case "Task": case "Agent": return "⚇";
    case "AskUserQuestion": return "?";
    default: return name.startsWith("mcp__") ? "⋈" : "•";
  }
}
