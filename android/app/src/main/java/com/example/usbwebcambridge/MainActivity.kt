package com.example.usbwebcambridge

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import android.widget.Button
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

/**
 * MainActivity — single-screen UI with Start/Stop button and status text.
 *
 * Delegates all camera + encoding + streaming work to CameraStreamer.
 */
class MainActivity : AppCompatActivity() {

    companion object {
        private const val CAMERA_PERMISSION_REQUEST = 100
    }

    private lateinit var btnToggle: Button
    private lateinit var tvStatus: TextView
    private lateinit var streamer: CameraStreamer

    private var isStreaming = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        btnToggle = findViewById(R.id.btnToggle)
        tvStatus  = findViewById(R.id.tvStatus)
        val textureView: android.view.TextureView = findViewById(R.id.textureView)

        streamer = CameraStreamer(this, textureView) { status ->
            // Status callback — runs on any thread, post to UI thread
            runOnUiThread { tvStatus.text = status }
        }

        btnToggle.setOnClickListener {
            if (!isStreaming) {
                startStreaming()
            } else {
                stopStreaming()
            }
        }
    }

    override fun onResume() {
        super.onResume()
        if (!isStreaming) {
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

        window.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        isStreaming = true
        btnToggle.text = "Stop Streaming"
        tvStatus.text = "Starting…"
        streamer.start()
    }

    private fun stopStreaming() {
        window.clearFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        isStreaming = false
        btnToggle.text = "Start Streaming"
        tvStatus.text = "Stopped"
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
            // Permission granted — try starting again
            startStreaming()
        } else {
            tvStatus.text = "Camera permission denied"
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        if (isStreaming) streamer.stop()
    }
}
