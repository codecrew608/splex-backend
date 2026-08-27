import Link from "next/link";
import { NewProjectForm } from "@/components/projects/NewProjectForm";

export default function NewProjectPage() {
  return (
    <div className="mx-auto h-dvh max-w-2xl overflow-y-auto px-4 pb-10 pt-14 sm:px-6 sm:pt-10">
      <p className="text-xs text-muted-foreground">
        <Link href="/projects" className="hover:text-foreground">
          Projects
        </Link>
        {" / "}
        New
      </p>
      <h1 className="mt-1 text-xl font-semibold text-foreground">Create a project</h1>
      <p className="mt-1.5 text-sm text-muted-foreground">
        A project groups related chats together. Give it a name and, if it helps, a description — then start
        chats inside it.
      </p>
      <NewProjectForm />
    </div>
  );
}
