import { ContactForm } from "./contact-form";
import { InteractiveGrid } from "./interactive-grid";
import styles from "./studio-home.module.css";

interface ProjectItem {
  name: string;
  year: string;
  sector: string;
}

const projects: ProjectItem[] = [
  { name: "Apex Financial Terminal", year: "2023", sector: "Fintech" },
  { name: "Mono-Space Gallery", year: "2023", sector: "Culture" },
  { name: "Structure & Void", year: "2022", sector: "Architecture" },
  { name: "Grid Systems Intl.", year: "2022", sector: "E-Commerce" },
  { name: "Null_Pointer Exception", year: "2021", sector: "Experimental" },
];

const navItems: Array<{ label: string; section: "index" | "projects" | "agency" | "contact" }> = [
  { label: "Index [A]", section: "index" },
  { label: "Projects [B]", section: "projects" },
  { label: "Agency [C]", section: "agency" },
  { label: "Contact [D]", section: "contact" },
];

function PixelLogo() {
  const pattern = [
    [1, 1, 1, 1, 1],
    [1, 0, 0, 0, 0],
    [1, 0, 0, 0, 0],
    [1, 0, 0, 0, 0],
    [1, 1, 1, 1, 1],
  ];

  return (
    <div className={styles.pixelLogo} aria-hidden>
      {pattern.flat().map((cell, index) => (
        <span
          key={index}
          className={styles.pixelLogoCell}
          style={{ backgroundColor: cell ? "#000000" : "transparent" }}
        />
      ))}
    </div>
  );
}

function ProjectTable({ rows }: { rows: ProjectItem[] }) {
  return (
    <div className={styles.tableWrap}>
      <div className={styles.tableHeader}>
        <div className={styles.tableHeaderCell}>Client Name</div>
        <div className={styles.tableHeaderCell}>Year</div>
        <div className={styles.tableHeaderCell}>Sector</div>
      </div>
      {rows.map((item, index) => (
        <div
          key={`${item.name}-${item.year}-${index}`}
          className={styles.tableRow}
        >
          <div className={styles.tableCell}>{item.name}</div>
          <div className={`${styles.tableCell} ${styles.tableCellMono}`}>{item.year}</div>
          <div className={styles.tableCell}>{item.sector}</div>
        </div>
      ))}
    </div>
  );
}

export function StudioHome() {
  return (
    <div className={styles.home}>
      <InteractiveGrid />

      <nav className={styles.nav} aria-label="Primary sections">
        {navItems.map((item) => (
          <a
            key={item.section}
            className={styles.navLink}
            href={`#${item.section}`}
          >
            {item.label}
          </a>
        ))}
      </nav>

      <main className={styles.stage}>
        <section id="index" className={`${styles.contentCard} ${styles.heroCard}`}>
          <PixelLogo />
          <span className={styles.cardMeta}>SYS.OP.2024 // V.1.0.4</span>
          <h1 className={styles.cardSectionTitle}>Coordinate Studio</h1>
          <h2 className={styles.cardDisplayTitle}>
            We construct digital environments with rigorous precision and
            structural integrity.
          </h2>

          <div className={styles.twoColumnInfo}>
            <div>
              <span className={styles.cardMeta}>LOCATION</span>
              <p className={styles.cardBodyText}>
                New York, NY
                <br />
                10013
              </p>
            </div>
            <div>
              <span className={styles.cardMeta}>STATUS</span>
              <p className={styles.cardBodyText}>
                Accepting New
                <br />
                Commissions
              </p>
            </div>
          </div>
        </section>

        <section className={`${styles.contentCard} ${styles.projectsCard}`}>
          <h1 className={styles.cardSectionTitle}>Selected Architecture</h1>
          <ProjectTable rows={projects} />
        </section>

        <section className={`${styles.contentCard} ${styles.methodCard}`}>
          <h1 className={styles.cardSectionTitle}>Methodology</h1>
          <p className={styles.cardBodyText}>
            Our work is not decorated. It is engineered. We believe the web is
            a grid, not a canvas. By exposing the underlying logic of the
            browser, we create interfaces that feel honest, raw, and utilitarian.
          </p>
          <p className={styles.cardMonoLink}>-&gt; READ FULL PROTOCOL</p>
        </section>

        <section id="projects" className={`${styles.contentCard} ${styles.sectionCard}`}>
          <span className={styles.cardMeta}>SYS.PROJECTS // ALL WORK</span>
          <h1 className={styles.cardSectionTitle}>Project Archive</h1>
          <h2 className={styles.cardDisplayTitle}>
            A complete record of constructed digital environments.
          </h2>
          <ProjectTable rows={projects} />
        </section>

        <section id="agency" className={`${styles.contentCard} ${styles.sectionCard}`}>
          <PixelLogo />
          <span className={styles.cardMeta}>SYS.AGENCY // ABOUT</span>
          <h1 className={styles.cardSectionTitle}>About The Studio</h1>
          <h2 className={styles.cardDisplayTitle}>
            Founded on the principle that digital space deserves the same rigor as
            physical architecture.
          </h2>
          <p className={styles.cardBodyText}>
            Coordinate Studio is a digital design and engineering practice. We
            build precise, systematic, and undecorated digital environments that
            function as true instruments. Our approach treats the browser as a
            measurement tool, not a blank canvas.
          </p>
          <p className={styles.cardBodyText}>
            Every pixel is intentional. Every grid unit is accounted for. Every
            system is documented.
          </p>

          <div className={styles.agencyMetrics}>
            <div>
              <span className={styles.cardMeta}>FOUNDED</span>
              <p className={styles.metricValue}>2018</p>
            </div>
            <div>
              <span className={styles.cardMeta}>TEAM</span>
              <p className={styles.metricValue}>7 Members</p>
            </div>
            <div>
              <span className={styles.cardMeta}>PROJECTS</span>
              <p className={styles.metricValue}>40+</p>
            </div>
          </div>
        </section>

        <section id="contact" className={`${styles.contentCard} ${styles.contactCard}`}>
          <span className={styles.cardMeta}>SYS.CONTACT // INITIATE</span>
          <h1 className={styles.cardSectionTitle}>Open A Commission</h1>
          <h2 className={styles.cardDisplayTitle}>Ready to construct something precise?</h2>
          <ContactForm />
        </section>
      </main>
    </div>
  );
}
