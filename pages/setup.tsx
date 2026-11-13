import "./style.css";
export default function SetupPage() {
  return (
    <div className="setup-page">
      <a href="/" className="brand">
        <span className="brand-mark">vz↗</span>Back to workspace
      </a>
      <div className="eyebrow">GET STARTED</div>
      <h1>From build to insight.</h1>
      <p>Connect your repository once. Every enabled GitHub Actions build gets its own report.</p>
      <section className="panel">
        <h2>01 / Install the GitHub App</h2>
        <p>
          Sign in from the workspace and install the platform’s GitHub App on the repositories you
          want to connect. Repository visibility controls access to all reports and source.
        </p>
        <h2>02 / Add the plugin</h2>
        <pre>{`vp add -D vite-plugin-vz\n\nimport vz from "vite-plugin-vz";\n\nexport default defineConfig({\n  plugins: [\n    vz({\n      endpoint: "https://<your-platform-host>",\n      project: "web",\n      enabled: process.env.UPLOAD_DIAGNOSTICS !== "false",\n    }),\n  ],\n});`}</pre>
        <p>
          Use a unique project key for each app in a monorepo. Without a key, VZ uses the app
          directory relative to the checkout root.
        </p>
        <h2>03 / Allow trusted CI uploads</h2>
        <pre>{`permissions:\n  contents: read\n  id-token: write\n\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: voidzero-dev/setup-vp@v1\n      - run: vp install --frozen-lockfile\n      - run: vp build`}</pre>
        <p>
          No upload secret is required. VZ verifies the GitHub Actions identity, uploads full
          Rolldown diagnostics, and prints the report URL.
        </p>
        <div className="notice">
          Local builds do not capture or upload data. Upload failures warn by default; set{" "}
          <code>strict: true</code> to make them fail CI.
        </div>
      </section>
    </div>
  );
}
