/**
 * One picture or one video, full size (issue #168).
 *
 * A screen and not a view laid over the transcript, which is #167's whole
 * lesson: the phone's back gesture and its back control are the same gesture as
 * the one that leaves a screen, so a picture outside the stack meant one gesture
 * shut nothing and skipped a level. Every way out of here — the tap, the
 * control, the gesture, the button — is one `goBack`.
 *
 * Unlike the page, the route may name the picture. A route parameter is not an
 * address bar, so a token in the source cannot be written into a history
 * somebody can read.
 */
import { useState } from "react";
import { Dimensions, Pressable, Text, View } from "react-native";
import { Image } from "expo-image";
import { useVideoPlayer, VideoView } from "expo-video";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { mediaKind } from "@covey/web";
import { SIZE, T } from "../theme";
import type { Routes } from "../nav";

type Props = NativeStackScreenProps<Routes, "Media">;

const { width, height } = Dimensions.get("window");

export function MediaScreen({ route, navigation }: Props) {
  const { src, alt } = route.params;
  const insets = useSafeAreaInsets();
  const [failed, setFailed] = useState(false);
  // `alt` carries the original URL or the file's name, and the source may be a
  // route on the daemon with a token on it. The name is what says what kind of
  // thing this is; the token-bearing source would not.
  const kind = mediaKind(alt) ?? mediaKind(src) ?? "image";

  const player = useVideoPlayer(kind === "video" ? src : null, (p) => {
    p.loop = false;
    // A reader who tapped a video asked to watch it.
    if (kind === "video") p.play();
  });

  return (
    <View style={{ flex: 1, backgroundColor: "#000000" }}>
      <Pressable
        // A tap anywhere shuts it, the same as the page's own lightbox.
        onPress={() => navigation.goBack()}
        style={{ flex: 1, alignItems: "center", justifyContent: "center" }}
      >
        {failed ? (
          <Text style={{ color: T.muted, fontSize: SIZE.body, padding: 32, textAlign: "center" }}>
            That machine would not send the file.
          </Text>
        ) : kind === "video" ? (
          <VideoView
            player={player}
            style={{ width, height: height * 0.7 }}
            allowsPictureInPicture
            contentFit="contain"
          />
        ) : (
          <Image
            source={{ uri: src }}
            style={{ width, height }}
            contentFit="contain"
            onError={() => setFailed(true)}
            transition={120}
          />
        )}
      </Pressable>

      <Pressable
        onPress={() => navigation.goBack()}
        hitSlop={12}
        accessibilityLabel="Close"
        style={{ position: "absolute", top: insets.top + 8, right: 16 + insets.right, width: 36, height: 36, borderRadius: 18, backgroundColor: "#00000099", alignItems: "center", justifyContent: "center" }}
      >
        <Text style={{ color: "#ffffff", fontSize: 19 }}>✕</Text>
      </Pressable>

      <Text
        numberOfLines={2}
        style={{ position: "absolute", bottom: insets.bottom + 12, left: 16 + insets.left, right: 16 + insets.right, color: "#ffffffcc", fontSize: SIZE.small }}
      >
        {alt}
      </Text>
    </View>
  );
}
