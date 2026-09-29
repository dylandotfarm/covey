/**
 * A reply, painted (issue #168).
 *
 * `markdown.ts` decided what the blocks and spans are and is held to the web
 * client's own reading by test. This file only paints them, and the one rule it
 * adds is React Native's own: a `<Text>` takes a string, never markup, so a
 * reply cannot put views on the screen. The page has to escape for that; this
 * gets it for nothing.
 *
 * Media is inline, as it is on the page (#110), and capped at a fraction of the
 * screen. A tap opens it full size — and full size is a *route*, not a view laid
 * over this one, which is #167's lesson: the phone's back gesture and the
 * control beside it are the same gesture as the one that leaves a screen, so a
 * picture outside the route meant one gesture shut nothing.
 */
import { memo } from "react";
import { Dimensions, Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { Image } from "expo-image";
import { markdownBlocks, type Block, type Span } from "../markdown";
import { MONO, SIZE, T } from "../theme";
import { Icon } from "../Icon";

/** What the painter needs from the screen it is on. */
export interface MarkdownContext {
  /** Turn a URL in a reply into one this device can load (a GitHub attachment goes via the daemon). */
  src: (url: string) => string;
  /** A `#N` was tapped. */
  onRef?: (number: number) => void;
  /** A picture was tapped: open it as a route. */
  onMedia?: (src: string, alt: string) => void;
}

/** 40% of the screen, the cap the page's style sheet uses. */
const MEDIA_MAX = Math.round(Dimensions.get("window").height * 0.4);

const st = StyleSheet.create({
  para: { color: T.text, fontSize: SIZE.body, lineHeight: 22 },
  h1: { color: T.text, fontSize: SIZE.heading, fontWeight: "700", marginTop: 8, marginBottom: 2 },
  h2: { color: T.text, fontSize: SIZE.title, fontWeight: "700", marginTop: 8, marginBottom: 2 },
  h3: { color: T.text, fontSize: SIZE.body, fontWeight: "700", marginTop: 6, marginBottom: 2 },
  code: { fontFamily: MONO, fontSize: 12.5, color: T.code },
  fence: { backgroundColor: T.surfaceAlt, borderRadius: 8, padding: 10, marginVertical: 6 },
  bullet: { flexDirection: "row", gap: 8, paddingLeft: 2 },
  media: { width: "100%", height: MEDIA_MAX, borderRadius: 8, marginVertical: 6, backgroundColor: T.surfaceAlt },
  cell: { flex: 1, paddingHorizontal: 6, paddingVertical: 4 },
  tableRow: { flexDirection: "row", borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: T.border },
});

/** One run of spans, as nested `<Text>`. */
function Spans({ spans, ctx, bold }: { spans: Span[]; ctx: MarkdownContext; bold?: boolean }) {
  return (
    <>
      {spans.map((s, i) => {
        const key = i;
        switch (s.kind) {
          case "text":
            return <Text key={key} style={bold ? { fontWeight: "700" } : undefined}>{s.text}</Text>;
          case "code":
            return <Text key={key} style={st.code}>{s.text}</Text>;
          case "bold":
            return <Text key={key} style={{ fontWeight: "700" }}><Spans spans={s.spans} ctx={ctx} bold /></Text>;
          case "link":
            return (
              <Text key={key} style={{ color: T.accent }} onPress={() => void Linking.openURL(s.url).catch(() => {})}>
                <Spans spans={s.spans} ctx={ctx} bold={bold} />
              </Text>
            );
          case "ref":
            // A `#N` opens the issue or the pull request on this device (#108).
            return (
              <Text key={key} style={{ color: T.accent }} onPress={ctx.onRef ? () => ctx.onRef!(s.number) : undefined}>
                {s.text}
              </Text>
            );
          case "image":
            // An image inside a line of prose still gets a line of its own: a
            // phone has no room to flow text around a screenshot.
            return <Text key={key} style={{ color: T.subtle }}>{s.alt || "[image]"}</Text>;
        }
      })}
    </>
  );
}

/** A picture or a video, inline and tappable. */
function Media({ url, kind, ctx }: { url: string; kind: "image" | "video"; ctx: MarkdownContext }) {
  const src = ctx.src(url);
  return (
    <Pressable onPress={ctx.onMedia ? () => ctx.onMedia!(src, url) : undefined}>
      <Image source={{ uri: src }} style={st.media} contentFit="contain" transition={120} />
      {kind === "video" ? (
        // A first frame and a word. The full-size route plays it; a thumbnail
        // that played would cost the frame budget for something nobody asked to
        // watch yet.
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 4, marginTop: -22, marginBottom: 8 }}>
          <Icon name="play" size={15} colour={T.subtle} />
          <Text style={{ color: T.subtle, fontSize: SIZE.small }}>video — tap to play</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

function BlockView({ block, ctx }: { block: Block; ctx: MarkdownContext }) {
  switch (block.kind) {
    case "para":
      return (
        <Text style={st.para}>
          {block.lines.map((line, i) => (
            <Text key={i}>
              {i > 0 ? "\n" : ""}
              <Spans spans={line} ctx={ctx} />
            </Text>
          ))}
        </Text>
      );
    case "heading": {
      const style = block.level === 1 ? st.h1 : block.level === 2 ? st.h2 : st.h3;
      return <Text style={style}><Spans spans={block.spans} ctx={ctx} /></Text>;
    }
    case "code":
      return (
        <View style={st.fence}>
          {block.lang ? <Text style={{ color: T.subtle, fontSize: 10, marginBottom: 4 }}>{block.lang}</Text> : null}
          <Text style={st.code} selectable>{block.text}</Text>
        </View>
      );
    case "list":
      return (
        <View style={{ gap: 3, marginVertical: 4 }}>
          {block.items.map((item, i) => (
            <View key={i} style={st.bullet}>
              <Text style={[st.para, { color: T.subtle }]}>{block.ordered ? `${i + 1}.` : "•"}</Text>
              <Text style={[st.para, { flex: 1 }]}><Spans spans={item} ctx={ctx} /></Text>
            </View>
          ))}
        </View>
      );
    case "table":
      // The page gives a table a box that scrolls sideways. A phone's app has
      // less room again, so the columns share the width evenly and a long cell
      // wraps — a table a reader has to drag is a table they do not read.
      return (
        <View style={{ borderWidth: StyleSheet.hairlineWidth, borderColor: T.border, borderRadius: 8, marginVertical: 6, overflow: "hidden" }}>
          <View style={{ flexDirection: "row", backgroundColor: T.surfaceAlt }}>
            {block.table.header.map((cell, j) => (
              <Text key={j} style={[st.cell, st.para, { fontWeight: "700", textAlign: block.table.align[j] ?? "left" }]}>{cell}</Text>
            ))}
          </View>
          {block.table.rows.map((row, i) => (
            <View key={i} style={st.tableRow}>
              {row.map((cell, j) => (
                <Text key={j} style={[st.cell, st.para, { textAlign: block.table.align[j] ?? "left" }]}>{cell}</Text>
              ))}
            </View>
          ))}
        </View>
      );
    case "media":
      return <Media url={block.url} kind={block.media} ctx={ctx} />;
  }
}

/**
 * A reply.
 *
 * Memoised on the text and nothing else that changes per frame: a turn re-sends
 * a streaming item every few tens of milliseconds, and re-parsing every reply in
 * the transcript on each of those is the whole frame budget.
 */
export const Markdown = memo(function Markdown({ text, ctx }: { text: string; ctx: MarkdownContext }) {
  const blocks = markdownBlocks(text);
  return (
    <View style={{ gap: 2 }}>
      {blocks.map((b, i) => <BlockView key={i} block={b} ctx={ctx} />)}
    </View>
  );
});
