package com.avishek.ledger;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

// Downloads an APK and launches the system installer, so a native update needs
// only "tap Download -> tap Install" instead of a browser round-trip.
@CapacitorPlugin(name = "ApkInstaller")
public class ApkInstaller extends Plugin {

    @PluginMethod
    public void installFromUrl(final PluginCall call) {
        final String url = call.getString("url");
        if (url == null || url.isEmpty()) { call.reject("missing url"); return; }

        // Android 8+ needs the user to allow "install unknown apps" for this app.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                && !getContext().getPackageManager().canRequestPackageInstalls()) {
            Intent settings = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + getContext().getPackageName()));
            settings.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(settings);
            JSObject ret = new JSObject();
            ret.put("needsPermission", true);
            call.resolve(ret);
            return;
        }

        new Thread(new Runnable() {
            @Override public void run() {
                HttpURLConnection conn = null;
                try {
                    File apk = new File(getContext().getCacheDir(), "update.apk");
                    if (apk.exists()) apk.delete();

                    conn = (HttpURLConnection) new URL(url).openConnection();
                    conn.setInstanceFollowRedirects(true); // GitHub asset -> CDN redirect (https->https)
                    conn.setConnectTimeout(30000);
                    conn.setReadTimeout(60000);
                    conn.connect();

                    InputStream in = conn.getInputStream();
                    FileOutputStream out = new FileOutputStream(apk);
                    byte[] buf = new byte[8192];
                    int n;
                    while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
                    out.flush(); out.close(); in.close();

                    Uri uri = FileProvider.getUriForFile(getContext(),
                            getContext().getPackageName() + ".fileprovider", apk);
                    Intent intent = new Intent(Intent.ACTION_VIEW);
                    intent.setDataAndType(uri, "application/vnd.android.package-archive");
                    intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                    getContext().startActivity(intent);

                    JSObject ret = new JSObject();
                    ret.put("started", true);
                    call.resolve(ret);
                } catch (Exception e) {
                    call.reject(e.getMessage() == null ? "install failed" : e.getMessage());
                } finally {
                    if (conn != null) conn.disconnect();
                }
            }
        }).start();
    }
}
