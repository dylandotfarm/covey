/**
 * A row that slides left to show a button under it (#172).
 *
 * The web client's gesture, in React Native's terms, down to its numbers: a
 * thread row on the phone's page reveals **Archive** the same way, and a
 * conversation that archives with one gesture on one client and two on the other
 * is a conversation a reader has to think about twice.
 *
 * It is a *reveal*, not a swipe that acts. A drag that archived on release
 * would archive on the drag somebody made by accident while scrolling, and
 * there is no undo: the row leaves the list and only the TUI brings it back. So
 * the swipe shows the button and the button does the work — two deliberate acts,
 * neither of them a confirmation dialog nobody reads.
 *
 * Written with `PanResponder` and `Animated`, which React Native already has.
 * The alternatives are a deprecated component or `react-native-reanimated`, and
 * the second is native code: it would cost a new build and a sideload to slide a
 * row sideways.
 *
 * The one rule that makes it live inside a list: **claim only a sideways drag.**
 * `onMoveShouldSetPanResponder` compares the two axes, so a finger going up the
 * transcript still scrolls it, and a row only takes the gesture once it is more
 * across than along.
 */
import { useEffect, useRef, type ReactNode } from "react";
import { Animated, PanResponder, Pressable, StyleSheet, Text, View } from "react-native";
import { SIZE, T } from "../theme";

/** How far the row slides, in points. The web client's own figure. */
const REVEAL = 88;
/** Past half way on release, it stays open. */
const COMMIT = REVEAL / 2;
/** Below this the finger has not said which way it is going. */
const SLOP = 8;

export interface SwipeRowProps {
  /** This row is the one that is open. The list holds that, so only one is. */
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  onPress: () => void;
  onLongPress?: () => void;
  action: { label: string; onPress: () => void };
  children: ReactNode;
  first?: boolean;
}

export function SwipeRow(p: SwipeRowProps) {
  const x = useRef(new Animated.Value(0)).current;
  /** Where the slide was when this gesture started. */
  const base = useRef(0);
  /** Set once the drag has said which way it goes; null until then. */
  const sideways = useRef<boolean | null>(null);

  const slide = (to: number) => {
    base.current = to;
    Animated.spring(x, { toValue: to, useNativeDriver: true, bounciness: 0, speed: 20 }).start();
  };

  // The list can shut this row — because another one opened, or because the
  // reader tapped elsewhere — and the animation has to follow.
  useEffect(() => { slide(p.open ? -REVEAL : 0); }, [p.open]);

  const pan = useRef(
    PanResponder.create({
      // Never on the down press: a tap must reach the row under it.
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_e, g) => {
        // Sideways, and past the slop. Anything else belongs to the list's
        // scroll, and taking it would make the list feel stuck.
        if (Math.abs(g.dx) < SLOP) return false;
        return Math.abs(g.dx) > Math.abs(g.dy);
      },
      onPanResponderGrant: () => { sideways.current = null; },
      onPanResponderMove: (_e, g) => {
        const next = Math.max(-REVEAL, Math.min(0, base.current + g.dx));
        x.setValue(next);
      },
      onPanResponderRelease: (_e, g) => {
        const ended = Math.max(-REVEAL, Math.min(0, base.current + g.dx));
        const open = ended < -COMMIT;
        slide(open ? -REVEAL : 0);
        if (open) p.onOpen(); else p.onClose();
      },
      onPanResponderTerminate: () => slide(base.current),
    }),
  ).current;

  return (
    <View style={[st.wrap, p.first ? null : st.divider]}>
      {/* Underneath, and only reachable once the row has moved off it. */}
      <View style={st.behind} pointerEvents={p.open ? "auto" : "none"}>
        <Pressable style={st.action} onPress={p.action.onPress} accessibilityLabel={p.action.label}>
          <Text style={st.actionText}>{p.action.label}</Text>
        </Pressable>
      </View>

      <Animated.View style={{ transform: [{ translateX: x }] }} {...pan.panHandlers}>
        <Pressable
          // A tap on a row that is slid open shuts it rather than opening the
          // conversation, which is what the page does and what a thumb that
          // just swiped expects.
          onPress={() => (p.open ? p.onClose() : p.onPress())}
          onLongPress={p.onLongPress}
          android_ripple={{ color: T.surfaceAlt }}
          style={st.front}
        >
          {p.children}
        </Pressable>
      </Animated.View>
    </View>
  );
}

const st = StyleSheet.create({
  wrap: { backgroundColor: T.danger },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: T.border },
  behind: { position: "absolute", left: 0, right: 0, top: 0, bottom: 0, alignItems: "flex-end", justifyContent: "center" },
  action: { width: REVEAL, height: "100%", alignItems: "center", justifyContent: "center" },
  actionText: { color: "#ffffff", fontSize: SIZE.small, fontWeight: "700" },
  front: {
    backgroundColor: T.surface,
    paddingHorizontal: 14, paddingVertical: 12,
    flexDirection: "row", alignItems: "center", gap: 10,
  },
});
