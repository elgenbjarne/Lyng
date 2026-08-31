# Capacitor discovers the plugin class from its annotation. Keep it when an
# eventual release build enables shrinking.
-keep @com.getcapacitor.annotation.CapacitorPlugin public class * { *; }
