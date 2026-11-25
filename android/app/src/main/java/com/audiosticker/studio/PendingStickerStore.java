package com.audiosticker.studio;

public final class PendingStickerStore {
    private static volatile String pendingPayloadJson = null;

    private PendingStickerStore() {}

    public static void setPending(String json) {
        pendingPayloadJson = json;
    }

    public static String peekPending() {
        return pendingPayloadJson;
    }

    public static String consumePending() {
        String val = pendingPayloadJson;
        pendingPayloadJson = null;
        return val;
    }
}
