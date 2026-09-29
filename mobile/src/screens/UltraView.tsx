/**
 * A conversation on a screen too small for one (issue #172).
 *
 * The cover screen of a closed foldable is a few lines tall and as wide as a
 * card. A transcript there is unreadable — a single reply fills it and scrolls
 * away — so this shows the four things that survive at that size:
 *
 *  - **what the agent is doing**, as one chip;
 *  - **one sentence** about the last thing it said, which the daemon wrote
 *    (`digest.ts`) and which falls back to the reply's own opening;
 *  - **the pictures**, as thumbs, because a picture at 60 points still says
 *    what it is and a paragraph at 8 points does not;
 *  - **a way to reply**, which on this screen means dictation as much as typing.
 *
 * None of it is decided here. `threadActivity` and `replyLead` are in
 * `@covey/client` and node-tested, `threadMedia` is in `@covey/web`, and this
 * file lays them out. The one judgement it makes is what to leave out.
 */
import { memo } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Image } from "expo-image";
import { replyLead, threadActivity, type Activity } from "@covey/client";
import { threadMedia, type MediaRef } from "@covey/web";
import type { Thread, TimelineItem } from "@covey/protocol";
import { SIZE, T } from "../theme";

/** One colour per state. The chip is the only colour on this screen. */
const COLOUR: Record<Activity, string> = {
  asking: T.awaiting,
  approving: T.awaiting,
  working: T.working,
  thinking: T.working,
  ready: T.success,
  failed: T.danger,
  idle: T.subtle,
};

const st = StyleSheet.create({
  wrap: { paddingHorizontal: 12, paddingTop: 8, gap: 8 },
  head: { flexDirection: "row", alignItems: "center", gap: 8 },
  dot: { width: 9, height: 9, borderRadius: 5 },
  state: { fontSize: SIZE.body, fontWeight: "700" },
  detail: { color: T.subtle, fontSize: SIZE.small, flexShrink: 1 },
  lead: { color: T.text, fontSize: SIZE.body, lineHeight: 21 },
  thumbs: { flexDirection: "row", gap: 8, paddingVertical: 2 },
  thumb: { width: 64, height: 64, borderRadius: 8, backgroundColor: T.surfaceAlt },
  play: {
    position: "absolute", left: 0, right: 0, top: 0, bottom: 0,
    alignItems: "center", justifyContent: "center",
  },
});

export interface UltraProps {
  thread: Thread | null;
  items: TimelineItem[];
  /** Turn a media reference into something this device can load. */
  srcOf: (ref: MediaRef) => string;
  onMedia: (src: string, label: string) => void;
  /** Leave the small view for the full transcript. */
  onExpand: () => void;
}

/** A thumb. Big enough to recognise, small enough that four fit across. */
const Thumb = memo(function Thumb({ media, src, onPress }: { media: MediaRef; src: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityLabel={media.label}>
      <Image source={{ uri: src }} style={st.thumb} contentFit="cover" transition={100} />
      {media.kind === "video" ? (
        <View style={st.play} pointerEvents="none">
          <Text style={{ color: "#ffffff", fontSize: 19, textShadowColor: "#000", textShadowRadius: 4 }}>▶</Text>
        </View>
      ) : null}
    </Pressable>
  );
});

export function UltraView({ thread, items, srcOf, onMedia, onExpand }: UltraProps) {
  if (!thread) {
    return (
      <View style={st.wrap}>
        <Text style={st.detail}>Opening…</Text>
      </View>
    );
  }

  const state = threadActivity(thread, items);
  // The sentence the daemon wrote for the last reply, else that reply's own
  // opening. Never nothing: a blank screen here says less than a stale line.
  const lead = replyLead(items, 140);
  const media = threadMedia(items);
  // Newest first: on a screen this size the last picture is the one meant.
  const recent = [...media].reverse().slice(0, 8);

  return (
    <View style={st.wrap}>
      <Pressable onPress={onExpand} style={st.head} accessibilityLabel="Open the full conversation">
        <View style={[st.dot, { backgroundColor: COLOUR[state.activity] }]} />
        <Text style={[st.state, { color: COLOUR[state.activity] }]}>{state.label}</Text>
        {state.detail ? <Text style={st.detail} numberOfLines={1}>{state.detail}</Text> : null}
        <View style={{ flex: 1 }} />
        <Text style={{ color: T.faint, fontSize: 17 }}>›</Text>
      </Pressable>

      {lead ? (
        <Pressable onPress={onExpand}>
          {/* Three lines is what fits above a keyboard on a cover screen. */}
          <Text style={st.lead} numberOfLines={3}>{lead}</Text>
        </Pressable>
      ) : (
        <Text style={st.detail}>Nothing said yet.</Text>
      )}

      {recent.length ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={st.thumbs}>
          {recent.map((m) => {
            const src = srcOf(m);
            return <Thumb key={`${m.itemId}:${m.label}`} media={m} src={src} onPress={() => onMedia(src, m.label)} />;
          })}
        </ScrollView>
      ) : null}
    </View>
  );
}
