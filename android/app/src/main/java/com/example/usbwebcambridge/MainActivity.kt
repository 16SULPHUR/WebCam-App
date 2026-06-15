package com.example.usbwebcambridge

import android.Manifest
import android.content.pm.PackageManager
import android.graphics.SurfaceTexture
import android.os.Bundle
import android.view.TextureView
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

/**
 * MainActivity — Full-screen camera preview UI.
 *
 * Streaming auto-starts when the Activity resumes (no manual button required).
 * Shows live camera preview via TextureView while simultaneously encoding
 * and sending H.264 over TCP to the Windows bridge.
 */
class MainActivity : AppCompatActivity() {

    companion object {
        private const val CAMERA_PERMISSION_REQUEST = 100
    }

    private lateinit var cameraPreview: TextureView
    private lateinit var tvStatus: TextView
    private lateinit var tvRecBadge: TextView
    private lateinit var btnToggle: Button   // hidden, kept for compat
    private lateinit var streamer: CameraStreamer

    private var isStreaming = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Make the activity full-screen and keep screen on while streaming
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        setContentView(R.layout.activity_main)

        cameraPreview = findViewById(R.id.cameraPreview)
        tvStatus      = findViewById(R.id.tvStatus)
        tvRecBadge    = findViewById(R.id.tvRecBadge)
        btnToggle     = findViewById(R.id.btnToggle)

        streamer = CameraStreamer(this) { status ->
            runOnUiThread {
                tvStatus.text = status
                // Show LIVE badge when connected to PC
                val isConnected = status.contains("streaming", ignoreCase = true) ||
                                  status.contains("connected", ignoreCase = true)
                tvRecBadge.visibility = if (isConnected) View.VISIBLE else View.GONE
            }
        }

        // Wire up TextureView listener so we start streaming once the surface is ready
        cameraPreview.surfaceTextureListener = object : TextureView.SurfaceTextureListener {
            override fun onSurfaceTextureAvailable(surface: SurfaceTexture, w: Int, h: Int) {
                // Surface is ready — attempt to start streaming
                if (!isStreaming) {
                    streamer.setPreviewTextureView(cameraPreview)
                    startStreaming()
                }
            }
            override fun onSurfaceTextureSizeChanged(surface: SurfaceTexture, w: Int, h: Int) {}
            override fun onSurfaceTextureDestroyed(surface: SurfaceTexture): Boolean = true
            override fun onSurfaceTextureUpdated(surface: SurfaceTexture) {}
        }
    }

    override fun onResume() {
        super.onResume()
        // If the TextureView is already available and we're not streaming, start now
        if (!isStreaming && cameraPreview.isAvailable) {
            streamer.setPreviewTextureView(cameraPreview)
            startStreaming()
        }
    }

    private fun startStreaming() {
        // Check camera permission at runtime (required for API 23+)
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
            != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(
                this,
                arrayOf(Manifest.permission.CAMERA),
                CAMERA_PERMISSION_REQUEST
            )
            return
        }

        isStreaming = true
        tvStatus.text = "Starting camera…"
        streamer.start()
    }

    private fun stopStreaming() {
        isStreaming = false
        tvStatus.text = "Stopped"
        tvRecBadge.visibility = View.GONE
        streamer.stop()
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == CAMERA_PERMISSION_REQUEST &&
            grantResults.isNotEmpty() &&
            grantResults[0] == PackageManager.PERMISSION_GRANTED) {
            // Permission granted — start streaming
            startStreaming()
        } else {
            tvStatus.text = "Camera permission denied"
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        if (isStreaming) stopStreaming()
    }
}
