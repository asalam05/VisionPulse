# VisionPulse

**Intelligent monitoring for wellness and peace of mind.**

VisionPulse is a web-based wellness and monitoring application built with Vite, utilizing MediaPipe for computer vision tasks and WebSockets for real-time remote monitoring. 

## Features

- **Device Roles:** Choose to run as the *Host Camera* or a *Remote Monitor* using a secure PIN code.
- **Live Tracking & Geofencing:** Advanced video tracking with geofence configuration to ensure safety (e.g., Baby Monitor with bed boundaries).
- **Wellness Tracking:**
  - **Smile Intensity:** Detects and measures smile levels.
  - **Blink Counter:** Tracks blinks per minute to prevent eye strain.
  - **Posture Monitoring:** Monitors pitch angle to encourage good posture.
  - **Hydration Tracker:** Simple tracker to achieve daily water goals.
- **Baby Monitor:** Dedicated mode for monitoring infants.
- **Alerts & Integrations:** Integrates with sound alerts and smart light synchronization.

## Tech Stack

- **Frontend:** HTML, CSS, JavaScript (Vite)
- **Computer Vision:** `@mediapipe/tasks-vision`
- **Backend/Real-time:** Node.js, Express, Socket.io
- **Icons:** `lucide-static`

## Getting Started

### Prerequisites
- Node.js installed on your machine.

### Installation

1. Clone the repository and navigate to the project directory:
   ```bash
   cd VisionPulse
   ```
2. Install the dependencies:
   ```bash
   npm install
   ```

### Running the Application

To start the development server:
```bash
npm run dev
```

This will run the express server setup with Vite. Open your browser to the local address provided in the terminal to view the application.

## Usage
- Open the application and choose whether the current device will be the **Host Camera** or a **Remote Monitor**.
- Use the **Host Camera** to monitor activities. 
- Use the **Remote Monitor** on a different device to access the live dashboard by entering the PIN.
- Toggle various trackers (Smile, Blink, Posture, Baby Monitor) from the dashboard to customize your monitoring experience.

## License
Private
