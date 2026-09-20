<?php
/**
 * The template for displaying archive pages.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

get_header();
?>

<div class="page-hero">
	<div class="container">
		<h1><?php the_archive_title(); ?></h1>
	</div>
</div>

<main id="primary" class="site-main">
	<div class="container">
		<?php
		if ( have_posts() ) :
			while ( have_posts() ) :
				the_post();
				get_template_part( 'template-parts/content', get_post_type() );
			endwhile;
			the_posts_navigation();
		else :
			get_template_part( 'template-parts/content', 'none' );
		endif;
		?>
	</div>
</main>

<?php get_footer(); ?>
